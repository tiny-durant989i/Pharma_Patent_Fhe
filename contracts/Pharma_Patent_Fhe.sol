pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract PharmaPatentFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error InvalidArgument();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 cooldownSeconds);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PatentRegistered(uint256 indexed batchId, address indexed provider, uint256 patentId);
    event LicenseRegistered(uint256 indexed batchId, address indexed provider, uint256 licenseId);
    event TradeRegistered(uint256 indexed batchId, address indexed provider, uint256 tradeId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 patentValue, uint256 licenseFee, uint256 tradeAmount);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    mapping(uint256 => mapping(uint256 => euint32)) public encryptedPatents;
    mapping(uint256 => mapping(uint256 => euint32)) public encryptedLicenses;
    mapping(uint256 => mapping(uint256 => euint32)) public encryptedTrades;
    mapping(uint256 => uint256) public patentCount;
    mapping(uint256 => uint256) public licenseCount;
    mapping(uint256 => uint256) public tradeCount;

    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionRequestCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60;
        currentBatchId = 1;
        batchOpen = false;
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidArgument();
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) revert InvalidBatch();
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert InvalidBatch();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
    }

    function registerPatent(euint32 encryptedValue) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert InvalidBatch();
        lastSubmissionTime[msg.sender] = block.timestamp;
        uint256 patentId = ++patentCount[currentBatchId];
        encryptedPatents[currentBatchId][patentId] = encryptedValue;
        emit PatentRegistered(currentBatchId, msg.sender, patentId);
    }

    function registerLicense(euint32 encryptedFee) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert InvalidBatch();
        lastSubmissionTime[msg.sender] = block.timestamp;
        uint256 licenseId = ++licenseCount[currentBatchId];
        encryptedLicenses[currentBatchId][licenseId] = encryptedFee;
        emit LicenseRegistered(currentBatchId, msg.sender, licenseId);
    }

    function registerTrade(euint32 encryptedAmount) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert InvalidBatch();
        lastSubmissionTime[msg.sender] = block.timestamp;
        uint256 tradeId = ++tradeCount[currentBatchId];
        encryptedTrades[currentBatchId][tradeId] = encryptedAmount;
        emit TradeRegistered(currentBatchId, msg.sender, tradeId);
    }

    function requestBatchSummary(uint256 batchId) external whenNotPaused checkDecryptionRequestCooldown {
        if (batchId == 0 || batchId >= currentBatchId) revert InvalidArgument();
        if (patentCount[batchId] == 0 && licenseCount[batchId] == 0 && tradeCount[batchId] == 0) {
            revert InvalidArgument();
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        euint32 sumPatents = FHE.asEuint32(0);
        euint32 sumLicenses = FHE.asEuint32(0);
        euint32 sumTrades = FHE.asEuint32(0);

        for (uint256 i = 1; i <= patentCount[batchId]; i++) {
            sumPatents = sumPatents.fheAdd(encryptedPatents[batchId][i]);
        }
        for (uint256 i = 1; i <= licenseCount[batchId]; i++) {
            sumLicenses = sumLicenses.fheAdd(encryptedLicenses[batchId][i]);
        }
        for (uint256 i = 1; i <= tradeCount[batchId]; i++) {
            sumTrades = sumTrades.fheAdd(encryptedTrades[batchId][i]);
        }

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = sumPatents.toBytes32();
        cts[1] = sumLicenses.toBytes32();
        cts[2] = sumTrades.toBytes32();

        bytes32 stateHash = keccak256(abi.encode(cts, address(this)));
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext(batchId, stateHash, false);
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        DecryptionContext memory ctx = decryptionContexts[requestId];
        if (ctx.stateHash == 0) revert InvalidArgument();

        uint256 batchId = ctx.batchId;
        euint32 sumPatents = FHE.asEuint32(0);
        euint32 sumLicenses = FHE.asEuint32(0);
        euint32 sumTrades = FHE.asEuint32(0);

        for (uint256 i = 1; i <= patentCount[batchId]; i++) {
            sumPatents = sumPatents.fheAdd(encryptedPatents[batchId][i]);
        }
        for (uint256 i = 1; i <= licenseCount[batchId]; i++) {
            sumLicenses = sumLicenses.fheAdd(encryptedLicenses[batchId][i]);
        }
        for (uint256 i = 1; i <= tradeCount[batchId]; i++) {
            sumTrades = sumTrades.fheAdd(encryptedTrades[batchId][i]);
        }

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = sumPatents.toBytes32();
        cts[1] = sumLicenses.toBytes32();
        cts[2] = sumTrades.toBytes32();

        bytes32 currentHash = keccak256(abi.encode(cts, address(this)));
        if (currentHash != ctx.stateHash) revert StateMismatch();
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        uint256 patentValue = abi.decode(cleartexts[0:32], (uint256));
        uint256 licenseFee = abi.decode(cleartexts[32:64], (uint256));
        uint256 tradeAmount = abi.decode(cleartexts[64:96], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, patentValue, licenseFee, tradeAmount);
    }
}