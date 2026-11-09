// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaskEscrow, IERC20} from "../src/TaskEscrow.sol";

/// Arc Testnet: USDC_ADDRESS=0x3600000000000000000000000000000000000000
/// forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        vm.startBroadcast();
        TaskEscrow esc = new TaskEscrow(IERC20(usdc), resolver);
        vm.stopBroadcast();
        console.log("TaskEscrow deployed at", address(esc));
    }
}
