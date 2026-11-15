// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
contract DemoSwapPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable token0; address public immutable token1; address private immutable initializer;
    uint256 public reserve0; uint256 public reserve1; bool public initialized;
    error InvalidPair(); error InvalidAmount(); error NotInitialized(); error AlreadyInitialized(); error Expired(); error Slippage(); error UnsupportedTokenBehavior();
    event Initialized(uint256 reserve0, uint256 reserve1);
    event Swapped(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, address recipient);
    constructor(address t0,address t1) { if(t0==t1 || t0.code.length==0 || t1.code.length==0) revert InvalidPair(); token0=t0;token1=t1;initializer=msg.sender; }
    function initialize(uint256 amount0,uint256 amount1) external nonReentrant {
        require(msg.sender==initializer); if(initialized)revert AlreadyInitialized();if(amount0==0||amount1==0)revert InvalidAmount();
        uint256 b0=IERC20(token0).balanceOf(address(this));uint256 b1=IERC20(token1).balanceOf(address(this));
        IERC20(token0).safeTransferFrom(msg.sender,address(this),amount0);IERC20(token1).safeTransferFrom(msg.sender,address(this),amount1);
        if(IERC20(token0).balanceOf(address(this))-b0!=amount0||IERC20(token1).balanceOf(address(this))-b1!=amount1)revert UnsupportedTokenBehavior();
        reserve0=IERC20(token0).balanceOf(address(this));reserve1=IERC20(token1).balanceOf(address(this));initialized=true;emit Initialized(reserve0,reserve1);
    }
    function quoteExactInput(address tokenIn,uint256 amountIn) public view returns(uint256) {
        if(!initialized)revert NotInitialized();if(tokenIn!=token0&&tokenIn!=token1)revert InvalidPair();if(amountIn==0)revert InvalidAmount();
        (uint256 x,uint256 y)=tokenIn==token0?(reserve0,reserve1):(reserve1,reserve0);uint256 afterFee=amountIn*997;return afterFee*y/(x*1000+afterFee);
    }
    function swapExactInput(address tokenIn,uint256 amountIn,uint256 minAmountOut,uint256 deadline,address recipient) external nonReentrant returns(uint256 amountOut) {
        if(block.timestamp>deadline)revert Expired();require(recipient!=address(0)&&recipient!=address(this));
        amountOut=quoteExactInput(tokenIn,amountIn);if(amountOut==0||amountOut<minAmountOut)revert Slippage();
        address tokenOut=tokenIn==token0?token1:token0;uint256 beforeIn=IERC20(tokenIn).balanceOf(address(this));uint256 beforeOut=IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).safeTransferFrom(msg.sender,address(this),amountIn);if(IERC20(tokenIn).balanceOf(address(this))-beforeIn!=amountIn)revert UnsupportedTokenBehavior();
        IERC20(tokenOut).safeTransfer(recipient,amountOut);if(IERC20(tokenOut).balanceOf(recipient)-beforeOut!=amountOut)revert UnsupportedTokenBehavior();
        uint256 b0=IERC20(token0).balanceOf(address(this));uint256 b1=IERC20(token1).balanceOf(address(this));require(b0*b1>=reserve0*reserve1,"Invariant");reserve0=b0;reserve1=b1;
        emit Swapped(msg.sender,tokenIn,amountIn,amountOut,recipient);
    }
}
