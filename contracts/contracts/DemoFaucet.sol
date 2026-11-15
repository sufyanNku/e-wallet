// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
interface IMintable { function mint(address recipient, uint256 amount) external; }
contract DemoFaucet is AccessControl, ReentrancyGuard {
    uint256 public constant COOLDOWN = 60;
    uint256 public constant MAX_CLAIMS = 100;
    mapping(address => uint256) public claimAmount;
    mapping(address => mapping(address => uint256)) public nextClaimAt;
    mapping(address => mapping(address => uint256)) public claims;
    error UnsupportedToken(); error Cooldown(uint256 nextAt); error Quota();
    event Claimed(address indexed user, address indexed token, uint256 amount);
    constructor(address admin) { require(admin != address(0)); _grantRole(DEFAULT_ADMIN_ROLE, admin); }
    function configure(address token, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) { require(token.code.length > 0); claimAmount[token] = amount; }
    function claim(address token) external nonReentrant {
        uint256 amount = claimAmount[token]; if (amount == 0) revert UnsupportedToken();
        if (block.timestamp < nextClaimAt[msg.sender][token]) revert Cooldown(nextClaimAt[msg.sender][token]);
        if (claims[msg.sender][token] >= MAX_CLAIMS) revert Quota();
        nextClaimAt[msg.sender][token] = block.timestamp + COOLDOWN; claims[msg.sender][token]++;
        IMintable(token).mint(msg.sender, amount); emit Claimed(msg.sender, token, amount);
    }
}
