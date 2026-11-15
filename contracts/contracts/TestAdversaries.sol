// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
interface IShared {function execute(uint256 id)external;}
contract RejectingTarget { receive() external payable {revert("Rejected");} }
contract ReenteringTarget {
    IShared public shared;uint256 public id;uint256 public calls;
    function configure(address wallet,uint256 proposalId)external {shared=IShared(wallet);id=proposalId;}
    receive()external payable {calls++;try shared.execute(id) {} catch {}}
}
contract FeeToken is ERC20 {
    constructor()ERC20("Demo Unsupported Fee Token","dFEE"){_mint(msg.sender,1_000_000 ether);}
    function _update(address from,address to,uint256 amount)internal override {if(from!=address(0)&&to!=address(0)&&amount>10){super._update(from,address(0),amount/10);super._update(from,to,amount-amount/10);}else super._update(from,to,amount);}
}
