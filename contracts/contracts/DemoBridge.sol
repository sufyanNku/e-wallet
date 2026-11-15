// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
interface IBridgeMintable {function mint(address recipient,uint256 amount) external;}
contract DemoBridgeLock is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable token;uint256 public immutable destinationChain;uint256 public nonce;
    error InvalidDestination();error UnsupportedTokenBehavior();
    event Locked(bytes32 indexed messageId,uint256 nonce,address indexed sender,address indexed recipient,uint256 amount,uint256 destinationChain);
    constructor(address token_,uint256 destination_) {require(block.chainid==31337&&destination_==31338&&token_.code.length>0);token=token_;destinationChain=destination_;}
    function lock(uint256 amount,address recipient,uint256 destination) external nonReentrant returns(bytes32 id) {
        if(destination!=destinationChain)revert InvalidDestination();require(amount>0&&recipient!=address(0));uint256 before_=IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender,address(this),amount);if(IERC20(token).balanceOf(address(this))-before_!=amount)revert UnsupportedTokenBehavior();
        uint256 sequence=nonce++;id=keccak256(abi.encode(block.chainid,address(this),sequence,destination,recipient,amount));emit Locked(id,sequence,msg.sender,recipient,amount,destination);
    }
}
contract DemoBridgeMint is AccessControl,ReentrancyGuard {
    bytes32 public constant RELAYER_ROLE=keccak256("RELAYER_ROLE");
    address public immutable token;address public immutable sourceLock;mapping(bytes32=>bool)public consumed;
    error InvalidMessage();error Replay();event Minted(bytes32 indexed messageId,address indexed recipient,uint256 amount);
    constructor(address token_,address sourceLock_,address relayer) {require(block.chainid==31338&&token_.code.length>0&&sourceLock_!=address(0)&&relayer!=address(0));token=token_;sourceLock=sourceLock_;_grantRole(DEFAULT_ADMIN_ROLE,msg.sender);_grantRole(RELAYER_ROLE,relayer);}
    function mintFromLock(bytes32 id,uint256 sourceNonce,address recipient,uint256 amount) external onlyRole(RELAYER_ROLE) nonReentrant {
        if(id!=keccak256(abi.encode(uint256(31337),sourceLock,sourceNonce,block.chainid,recipient,amount))||recipient==address(0)||amount==0)revert InvalidMessage();if(consumed[id])revert Replay();consumed[id]=true;IBridgeMintable(token).mint(recipient,amount);emit Minted(id,recipient,amount);
    }
}
