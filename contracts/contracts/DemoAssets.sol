// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract DemoERC20 is ERC20Capped, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint8 private immutable precision;
    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 cap_, address admin)
        ERC20(name_, symbol_) ERC20Capped(cap_) {
        require(decimals_ <= 36 && admin != address(0), "Invalid configuration");
        precision = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }
    function decimals() public view override returns (uint8) { return precision; }
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) { _mint(to, amount); }
}

contract DemoNFT721 is ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    constructor(address admin) ERC721("Demo Campus Pass", "dCAMP") {
        require(admin != address(0));
        _grantRole(DEFAULT_ADMIN_ROLE, admin); _grantRole(MINTER_ROLE, admin);
    }
    function mint(address to, uint256 id, string calldata uri) external onlyRole(MINTER_ROLE) {
        _safeMint(to, id); _setTokenURI(id, uri);
    }
    function supportsInterface(bytes4 id) public view override(ERC721URIStorage, AccessControl) returns (bool) { return super.supportsInterface(id); }
}

contract DemoNFT1155 is ERC1155, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    constructor(address admin, string memory uri_) ERC1155(uri_) {
        require(admin != address(0));
        _grantRole(DEFAULT_ADMIN_ROLE, admin); _grantRole(MINTER_ROLE, admin);
    }
    function mint(address to, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) { _mint(to, id, amount, ""); }
    function mintBatch(address to, uint256[] calldata ids, uint256[] calldata amounts) external onlyRole(MINTER_ROLE) { _mintBatch(to, ids, amounts, ""); }
    function supportsInterface(bytes4 id) public view override(ERC1155, AccessControl) returns (bool) { return super.supportsInterface(id); }
}
