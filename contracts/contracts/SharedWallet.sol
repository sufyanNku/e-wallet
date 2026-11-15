// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
contract SharedWallet is ReentrancyGuard {
    struct Proposal { address destination; uint256 value; bytes data; address proposer; bool executed; uint256 confirmations; }
    uint256 public constant THRESHOLD = 2;
    address[3] public owners;
    mapping(address => bool) public isOwner;
    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public approved;
    error InvalidOwners(); error NotOwner(); error AlreadyApproved(); error NotApproved(); error AlreadyExecuted(); error ThresholdNotMet(); error CallFailed();
    event Proposed(uint256 indexed proposalId, address indexed proposer, address destination, uint256 value, bytes data);
    event Approved(uint256 indexed proposalId, address indexed owner);
    event Revoked(uint256 indexed proposalId, address indexed owner);
    event Executed(uint256 indexed proposalId);
    modifier onlyOwner() { if (!isOwner[msg.sender]) revert NotOwner(); _; }
    constructor(address[3] memory owners_) { for (uint256 i; i < 3; i++) { if (owners_[i] == address(0) || isOwner[owners_[i]]) revert InvalidOwners(); owners[i] = owners_[i]; isOwner[owners_[i]] = true; } }
    receive() external payable {}
    function propose(address destination, uint256 value, bytes calldata data) external onlyOwner returns (uint256 id) {
        require(destination != address(0)); id = proposals.length;
        proposals.push(Proposal(destination, value, data, msg.sender, false, 0)); emit Proposed(id, msg.sender, destination, value, data);
    }
    function approve(uint256 id) external onlyOwner { Proposal storage p = proposals[id]; if (p.executed) revert AlreadyExecuted(); if (approved[id][msg.sender]) revert AlreadyApproved(); approved[id][msg.sender] = true; p.confirmations++; emit Approved(id, msg.sender); }
    function revoke(uint256 id) external onlyOwner { Proposal storage p = proposals[id]; if (p.executed) revert AlreadyExecuted(); if (!approved[id][msg.sender]) revert NotApproved(); approved[id][msg.sender] = false; p.confirmations--; emit Revoked(id, msg.sender); }
    function execute(uint256 id) external onlyOwner nonReentrant {
        Proposal storage p = proposals[id]; if (p.executed) revert AlreadyExecuted(); if (p.confirmations < THRESHOLD) revert ThresholdNotMet();
        p.executed = true; (bool ok,) = p.destination.call{value:p.value}(p.data); if (!ok) revert CallFailed(); emit Executed(id);
    }
    function proposal(uint256 id) external view returns (Proposal memory) { return proposals[id]; }
    function proposalCount() external view returns (uint256) { return proposals.length; }
}
