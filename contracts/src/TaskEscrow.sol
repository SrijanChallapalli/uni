// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title TaskEscrow — holds a single errand's service fee (USDC) until handoff, refund or resolution.
/// @notice Only the service fee is escrowed; workers never front purchase costs (orders are prepaid).
/// Trust assumptions (disclosed in the app):
///  - `resolver` is a centralized address operated by the app team. It can refund the payer at any
///    time while funds are held, and it decides disputes. It can never pay anyone other than the
///    recorded worker or payer.
///  - If the resolver does not act within RESOLVE_TIMEOUT of a dispute, anyone can trigger a refund
///    to the payer (bounded fallback).
/// No personal data is stored on-chain: `id` is an opaque hash of the app's payment id.
contract TaskEscrow {
    enum State { None, Funded, Released, Refunded, Disputed }

    struct Deal {
        address payer;
        address worker;
        uint96 amount;
        uint40 refundAfter; // payer may reclaim after this time if not released/disputed
        uint40 disputedAt;
        State state;
    }

    IERC20 public immutable token;
    address public immutable resolver;
    uint256 public constant RESOLVE_TIMEOUT = 72 hours;

    mapping(bytes32 => Deal) public deals;

    event Funded(bytes32 indexed id, address indexed payer, address indexed worker, uint256 amount, uint256 refundAfter);
    event Released(bytes32 indexed id, address indexed worker, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed payer, uint256 amount);
    event Disputed(bytes32 indexed id, address indexed by);
    event Resolved(bytes32 indexed id, bool toWorker, uint256 amount);

    error AlreadyExists();
    error BadState();
    error NotAllowed();
    error BadParams();
    error TransferFailed();

    constructor(IERC20 token_, address resolver_) {
        if (address(token_) == address(0) || resolver_ == address(0)) revert BadParams();
        token = token_;
        resolver = resolver_;
    }

    function fund(bytes32 id, address worker, uint96 amount, uint40 refundAfter) external {
        if (deals[id].state != State.None) revert AlreadyExists();
        if (worker == address(0) || worker == msg.sender || amount == 0 || refundAfter <= block.timestamp) revert BadParams();
        deals[id] = Deal(msg.sender, worker, amount, refundAfter, 0, State.Funded);
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(id, msg.sender, worker, amount, refundAfter);
    }

    /// Requester (payer) authorizes payment to the agreed worker.
    function release(bytes32 id) external {
        Deal storage d = deals[id];
        if (d.state != State.Funded) revert BadState();
        if (msg.sender != d.payer) revert NotAllowed();
        d.state = State.Released;
        _pay(d.worker, d.amount);
        emit Released(id, d.worker, d.amount);
    }

    /// Refund to payer: worker (voluntary cancel) any time, resolver any time, payer after refundAfter.
    function refund(bytes32 id) external {
        Deal storage d = deals[id];
        if (d.state != State.Funded) revert BadState();
        bool ok = msg.sender == d.worker || msg.sender == resolver || (msg.sender == d.payer && block.timestamp >= d.refundAfter);
        if (!ok) revert NotAllowed();
        d.state = State.Refunded;
        _pay(d.payer, d.amount);
        emit Refunded(id, d.payer, d.amount);
    }

    /// Either party (or the resolver acting on a party's in-app request) freezes funds.
    function dispute(bytes32 id) external {
        Deal storage d = deals[id];
        if (d.state != State.Funded) revert BadState();
        if (msg.sender != d.payer && msg.sender != d.worker && msg.sender != resolver) revert NotAllowed();
        d.state = State.Disputed;
        d.disputedAt = uint40(block.timestamp);
        emit Disputed(id, msg.sender);
    }

    function resolve(bytes32 id, bool toWorker) external {
        Deal storage d = deals[id];
        if (d.state != State.Disputed) revert BadState();
        if (msg.sender != resolver) revert NotAllowed();
        _settleDispute(id, d, toWorker);
    }

    /// Bounded fallback: if the resolver is silent for RESOLVE_TIMEOUT, anyone can refund the payer.
    function resolveByTimeout(bytes32 id) external {
        Deal storage d = deals[id];
        if (d.state != State.Disputed) revert BadState();
        if (block.timestamp < uint256(d.disputedAt) + RESOLVE_TIMEOUT) revert NotAllowed();
        _settleDispute(id, d, false);
    }

    function _settleDispute(bytes32 id, Deal storage d, bool toWorker) private {
        if (toWorker) {
            d.state = State.Released;
            _pay(d.worker, d.amount);
        } else {
            d.state = State.Refunded;
            _pay(d.payer, d.amount);
        }
        emit Resolved(id, toWorker, d.amount);
    }

    function _pay(address to, uint256 amount) private {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
