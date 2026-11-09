// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TaskEscrow, IERC20} from "../src/TaskEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract TaskEscrowTest is Test {
    TaskEscrow esc;
    MockUSDC usdc;
    address payer = address(0xA11CE);
    address worker = address(0xB0B);
    address resolver = address(0xD15);
    address stranger = address(0x5157);
    bytes32 id = keccak256("payment-1");
    uint96 constant FEE = 5_000_000; // $5.00

    function setUp() public {
        usdc = new MockUSDC();
        esc = new TaskEscrow(IERC20(address(usdc)), resolver);
        usdc.mint(payer, 100_000_000);
        vm.prank(payer);
        usdc.approve(address(esc), type(uint256).max);
    }

    function _fund() internal {
        vm.prank(payer);
        esc.fund(id, worker, FEE, uint40(block.timestamp + 1 days));
    }

    function _state() internal view returns (TaskEscrow.State s) {
        (,,,,, s) = esc.deals(id);
    }

    function test_fund_and_release_pays_worker() public {
        _fund();
        assertEq(usdc.balanceOf(address(esc)), FEE);
        vm.prank(payer);
        esc.release(id);
        assertEq(usdc.balanceOf(worker), FEE);
        assertEq(uint8(_state()), uint8(TaskEscrow.State.Released));
    }

    function test_double_funding_reverts() public {
        _fund();
        vm.prank(payer);
        vm.expectRevert(TaskEscrow.AlreadyExists.selector);
        esc.fund(id, worker, FEE, uint40(block.timestamp + 1 days));
    }

    function test_double_release_reverts() public {
        _fund();
        vm.startPrank(payer);
        esc.release(id);
        vm.expectRevert(TaskEscrow.BadState.selector);
        esc.release(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(worker), FEE);
    }

    function test_only_payer_can_release() public {
        _fund();
        vm.prank(worker);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.release(id);
        vm.prank(resolver);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.release(id);
    }

    function test_self_funding_to_self_rejected() public {
        vm.prank(payer);
        vm.expectRevert(TaskEscrow.BadParams.selector);
        esc.fund(id, payer, FEE, uint40(block.timestamp + 1 days));
    }

    function test_worker_can_refund_anytime_and_no_duplicate_refund() public {
        _fund();
        uint256 before = usdc.balanceOf(payer);
        vm.prank(worker);
        esc.refund(id);
        assertEq(usdc.balanceOf(payer), before + FEE);
        vm.prank(resolver);
        vm.expectRevert(TaskEscrow.BadState.selector);
        esc.refund(id);
    }

    function test_payer_refund_only_after_timeout() public {
        _fund();
        vm.prank(payer);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.refund(id);
        vm.warp(block.timestamp + 1 days);
        vm.prank(payer);
        esc.refund(id);
        assertEq(uint8(_state()), uint8(TaskEscrow.State.Refunded));
    }

    function test_stranger_cannot_refund_or_dispute() public {
        _fund();
        vm.startPrank(stranger);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.refund(id);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.dispute(id);
        vm.stopPrank();
    }

    function test_dispute_freezes_release_and_refund() public {
        _fund();
        vm.prank(worker);
        esc.dispute(id);
        vm.prank(payer);
        vm.expectRevert(TaskEscrow.BadState.selector);
        esc.release(id);
        vm.prank(worker);
        vm.expectRevert(TaskEscrow.BadState.selector);
        esc.refund(id);
    }

    function test_resolver_resolves_to_worker() public {
        _fund();
        vm.prank(payer);
        esc.dispute(id);
        vm.prank(stranger);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.resolve(id, true);
        vm.prank(resolver);
        esc.resolve(id, true);
        assertEq(usdc.balanceOf(worker), FEE);
        vm.prank(resolver);
        vm.expectRevert(TaskEscrow.BadState.selector);
        esc.resolve(id, false);
    }

    function test_timeout_fallback_refunds_payer() public {
        _fund();
        vm.prank(worker);
        esc.dispute(id);
        vm.expectRevert(TaskEscrow.NotAllowed.selector);
        esc.resolveByTimeout(id);
        vm.warp(block.timestamp + 72 hours);
        uint256 before = usdc.balanceOf(payer);
        vm.prank(stranger);
        esc.resolveByTimeout(id);
        assertEq(usdc.balanceOf(payer), before + FEE);
    }

    function testFuzz_conservation(uint96 amount, uint8 path) public {
        amount = uint96(bound(amount, 1, 100_000_000));
        vm.prank(payer);
        esc.fund(id, worker, amount, uint40(block.timestamp + 1 days));
        uint256 p = path % 4;
        if (p == 0) { vm.prank(payer); esc.release(id); }
        else if (p == 1) { vm.prank(worker); esc.refund(id); }
        else if (p == 2) { vm.prank(payer); esc.dispute(id); vm.prank(resolver); esc.resolve(id, true); }
        else { vm.prank(payer); esc.dispute(id); vm.warp(block.timestamp + 73 hours); esc.resolveByTimeout(id); }
        assertEq(usdc.balanceOf(address(esc)), 0);
        assertEq(usdc.balanceOf(payer) + usdc.balanceOf(worker), 100_000_000);
    }
}
