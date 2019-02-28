import {
    action,
    computed,
    observable }                   from 'mobx';
import { WS }                      from 'Services';
import {
    epochToMoment,
    getDiffDuration }              from 'Utils/Date';
import { formatPortfolioPosition } from './Helpers/format-response';
import {
    getDurationUnitText,
    getDurationUnitValue }         from './Helpers/details';
import {
    getDisplayStatus,
    getEndSpotTime,
    isUserSold,
    isValidToSell }                from '../Contract/Helpers/logic';
import BaseStore                   from '../../base-store';

export default class PortfolioStore extends BaseStore {
    @observable positions  = [];
    @observable is_loading = false;
    @observable error      = '';

    @action.bound
    initializePortfolio = () => {
        if (!this.root_store.client.is_logged_in) return;
        this.is_loading = true;

        WS.portfolio().then(this.portfolioHandler);
        WS.subscribeProposalOpenContract(null, this.proposalOpenContractHandler, false);
        WS.subscribeTransaction(this.transactionHandler, false);
    };

    @action.bound
    clearTable() {
        this.positions  = [];
        this.is_loading = false;
        this.error      = '';
    }

    @action.bound
    portfolioHandler(response) {
        this.is_loading = false;
        if ('error' in response) {
            this.error = response.error.message;
            return;
        }
        this.error = '';
        if (response.portfolio.contracts) {
            this.positions = response.portfolio.contracts
                .map(pos => formatPortfolioPosition(pos))
                .sort((pos1, pos2) => pos2.reference - pos1.reference); // new contracts first
        }
    }

    @action.bound
    transactionHandler(response) {
        if ('error' in response) {
            this.error = response.error.message;
        }
        if (!response.transaction) return;
        const { contract_id, action: act } = response.transaction;

        if (act === 'buy') {
            WS.portfolio().then((res) => {
                const new_pos = res.portfolio.contracts.find(pos => +pos.contract_id === +contract_id);
                if (!new_pos) return;
                this.pushNewPosition(new_pos);
            });
            // subscribe to new contract:
            WS.subscribeProposalOpenContract(contract_id, this.proposalOpenContractHandler, false);
        } else if (act === 'sell') {
            // TODO: Refactor with contract-store and use common helpers to handle contract result
            WS.proposalOpenContract(contract_id).then(action((proposal_response) => {
                // populate result details box for specified positions card
                this.populateResultDetails(proposal_response);
            }));
        }
    }

    @action.bound
    proposalOpenContractHandler(response) {
        if ('error' in response) return;

        const proposal = response.proposal_open_contract;
        const portfolio_position = this.positions.find((position) => +position.id === +proposal.contract_id);

        if (!portfolio_position) return;

        const prev_indicative = portfolio_position.indicative;
        const new_indicative  = +proposal.bid_price;
        const profit_loss     = +proposal.profit;

        portfolio_position.purchase_time = (proposal.is_forward_starting === 1) ?
            proposal.date_start
            :
            proposal.purchase_time;

        portfolio_position.bid_price        = proposal.bid_price;
        portfolio_position.indicative       = new_indicative;
        portfolio_position.underlying_code  = proposal.underlying;
        portfolio_position.underlying_name  = proposal.display_name;
        portfolio_position.profit_loss      = profit_loss;
        portfolio_position.tick_count       = proposal.tick_count;
        portfolio_position.is_valid_to_sell = isValidToSell(proposal);

        if (!proposal.is_valid_to_sell) {
            portfolio_position.status = 'no-resale';
        } else if (new_indicative > prev_indicative) {
            portfolio_position.status = 'price-moved-up';
        } else if (new_indicative < prev_indicative) {
            portfolio_position.status = 'price-moved-down';
        } else {
            portfolio_position.status = 'price-stable';
        }
    }

    @action.bound
    onClickSell(contract_id) {
        const i = this.positions.findIndex(pos => +pos.id === +contract_id);
        const bid_price = this.positions[i].bid_price;
        if (contract_id && bid_price) {
            WS.sell(contract_id, bid_price).then(this.handleSell);
        }
    }

    @action.bound
    handleSell(response) {
        const is_contract_mode = this.root_store.modules.smart_chart.is_contract_mode;
        // TODO: Refactor with ContractStore for re-drawing of chart markers and barriers
        // Toast messages are temporary UI for prompting user of sold contracts
        if (response.error) {
            // If unable to sell due to error, give error via toast message if not in contract mode
            this.root_store.ui.addToastMessage({
                message: response.error.message,
                type   : 'error',
            });
        // Check if still in contract_mode
        } else if (is_contract_mode && !response.error) {
            WS.forget('proposal_open_contract', this.root_store.modules.contract.updateProposal, { contract_id: response.sell.contract_id });
            WS.proposalOpenContract(response.sell.contract_id).then(action((proposal_response) => {
                // update contract store proposal after sell
                this.root_store.modules.contract.updateProposal(proposal_response);
                this.populateResultDetails(proposal_response);
            }));
            // update contract store sell info after sell
            this.root_store.modules.contract.sell_info = {
                sell_price    : response.sell.sold_for,
                transaction_id: response.sell.transaction_id,
            };
            this.root_store.ui.addToastMessage({
                message: `Contract was sold for ${response.sell.sold_for}.`,
                type   : 'info',
            });
        }
    }

    populateResultDetails(response) {
        const contract_response = response.proposal_open_contract;
        const i = this.positions.findIndex(pos => +pos.id === +contract_response.contract_id);
        const sell_time = isUserSold(contract_response) ?
            +contract_response.date_expiry
            :
            getEndSpotTime(contract_response);
        const duration_diff =
            getDiffDuration(
                epochToMoment(this.positions[i].purchase_time || this.positions[i].date_start),
                epochToMoment(this.positions[i].expiry_time)
            );
        const duration = this.positions[i].tick_count ?
            this.positions[i].tick_count
            :
            getDurationUnitValue(duration_diff);

        this.positions[i].id_sell       = +contract_response.transaction_ids.sell;
        this.positions[i].barrier       = +contract_response.barrier;
        this.positions[i].duration      = duration;
        this.positions[i].duration_unit = getDurationUnitText(duration_diff);
        this.positions[i].entry_spot    = +contract_response.entry_spot;
        this.positions[i].sell_time     = sell_time;
        this.positions[i].result        = getDisplayStatus(contract_response);
    }

    @action.bound
    pushNewPosition(new_pos) {
        this.positions.unshift(formatPortfolioPosition(new_pos));
    }

    @action.bound
    removePositionById(contract_id) {
        let i = this.positions.findIndex(pos => +pos.id === +contract_id);
        // check if position to be removed is out of range from the maximum amount rendered in drawer
        if (this.positions.length > 4) i += 1;
        this.positions.splice(i, 1);
    }

    @action.bound
    accountSwitcherListener () {
        return new Promise((resolve) => {
            this.clearTable();
            WS.forgetAll('proposal_open_contract', 'transaction');
            return resolve(this.initializePortfolio());
        });
    }

    @action.bound
    onMount() {
        this.onSwitchAccount(this.accountSwitcherListener.bind(null));
        if (this.positions.length === 0) {
            this.initializePortfolio();
        }
    }

    @action.bound
    onUnmount() {
        this.disposeSwitchAccount();
        // keep data and connections for portfolio drawer on desktop
        if (this.root_store.ui.is_mobile) {
            this.clearTable();
            WS.forgetAll('proposal_open_contract', 'transaction');
        }
    }

    @computed
    get totals() {
        let indicative = 0;
        let payout     = 0;
        let purchase   = 0;

        this.positions.forEach((portfolio_pos) => {
            indicative += (+portfolio_pos.indicative);
            payout     += (+portfolio_pos.payout);
            purchase   += (+portfolio_pos.purchase);
        });
        return {
            indicative,
            payout,
            purchase,
        };
    }

    @computed
    get active_positions() {
        return this.positions;
    }

    @computed
    get is_empty() {
        return !this.is_loading && this.active_positions.length === 0;
    }
}
