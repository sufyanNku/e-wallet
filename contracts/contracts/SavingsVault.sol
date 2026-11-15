// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
contract SavingsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    struct Position { address owner; address token; uint256 amount; uint256 depositedAt; uint256 unlockAt; bool withdrawn; }
    mapping(address => bool) public allowed;
    Position[] public positions;
    error UnsupportedToken(); error InvalidDuration(); error InvalidAmount(); error NotOwner(); error StillLocked(); error AlreadyWithdrawn(); error UnsupportedTokenBehavior();
    event Deposited(uint256 indexed positionId, address indexed owner, address indexed token, uint256 amount, uint256 unlockAt);
    event Withdrawn(uint256 indexed positionId, address indexed owner, uint256 amount);
    constructor(address[] memory tokens) { for (uint256 i; i < tokens.length; i++) { require(tokens[i].code.length > 0); allowed[tokens[i]] = true; } }
    function deposit(address token, uint256 amount, uint256 duration) external nonReentrant returns (uint256 id) {
        if (!allowed[token]) revert UnsupportedToken(); if (amount == 0) revert InvalidAmount();
        if (duration != 60 && duration != 300 && duration != 3600) revert InvalidDuration();
        uint256 before_ = IERC20(token).balanceOf(address(this)); IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before_ != amount) revert UnsupportedTokenBehavior();
        id = positions.length; positions.push(Position(msg.sender, token, amount, block.timestamp, block.timestamp + duration, false));
        emit Deposited(id, msg.sender, token, amount, block.timestamp + duration);
    }
    function withdraw(uint256 id) external nonReentrant {
        Position storage p = positions[id]; if (p.owner != msg.sender) revert NotOwner();
        if (p.withdrawn) revert AlreadyWithdrawn(); if (block.timestamp < p.unlockAt) revert StillLocked();
        p.withdrawn = true; uint256 before_ = IERC20(p.token).balanceOf(p.owner);
        IERC20(p.token).safeTransfer(p.owner, p.amount);
        if (IERC20(p.token).balanceOf(p.owner) - before_ != p.amount) revert UnsupportedTokenBehavior();
        emit Withdrawn(id, p.owner, p.amount);
    }
    function positionCount() external view returns (uint256) { return positions.length; }
}
