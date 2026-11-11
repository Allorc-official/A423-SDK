// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Experimental reference escrow for standard, non-rebasing ERC20 tokens.
/// No admin withdrawals/upgrades. Arbitration and timeout allocation are agreed before funding.
contract A423Escrow is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    enum State { None, Funded, Submitted, Verified, Disputed, Paid, Refunded, Split, Negotiating }
    struct Terms {
        bytes32 jobId;
        address payer;
        address worker;
        address verifier;
        address arbitrator;
        uint256 amount;
        uint64 workDeadline;
        uint64 reviewDeadline;
        uint64 resolutionDeadline;
        uint16 timeoutWorkerBps;
        bytes32 agreementHash;
    }
    struct Proposal {
        uint64 revision;
        uint64 expiresAt;
        address proposer;
        uint256 workerAmount;
        bytes32 proposalHash;
    }
    struct ClosingSettlement {
        bytes32 jobId;
        bytes32 agreementHash;
        uint64 escrowVersion;
        uint256 workerAmount;
        uint256 payerAmount;
        bytes32 proposalHash;
        uint64 expiresAt;
    }
    struct Job { Terms terms; State state; bytes32 resultHash; uint256 workerPaid; Proposal proposal; }
    IERC20 public immutable token;
    mapping(bytes32 => Job) private jobs;
    bytes32 public constant TERMS_TYPEHASH = keccak256("Terms(bytes32 jobId,address payer,address worker,address verifier,address arbitrator,uint256 amount,uint64 workDeadline,uint64 reviewDeadline,uint64 resolutionDeadline,uint16 timeoutWorkerBps,bytes32 agreementHash)");
    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256("ClosingSettlement(bytes32 jobId,bytes32 agreementHash,uint64 escrowVersion,uint256 workerAmount,uint256 payerAmount,bytes32 proposalHash,uint64 expiresAt)");
    event SettlementProposed(bytes32 indexed jobId, uint64 revision, address indexed proposer, uint256 workerAmount, uint256 payerAmount, bytes32 proposalHash, uint64 expiresAt);
    event SettlementAccepted(bytes32 indexed jobId, uint64 revision, bytes32 proposalHash);
    event Funded(bytes32 indexed jobId, bytes32 indexed agreementHash, address indexed payer, address worker, uint256 amount);
    event Submitted(bytes32 indexed jobId, bytes32 resultHash);
    event Verified(bytes32 indexed jobId, bytes32 resultHash);
    event Disputed(bytes32 indexed jobId, bytes32 reasonHash);
    event Settled(bytes32 indexed jobId, uint256 workerAmount, uint256 payerAmount, uint8 reason);
    error InvalidTerms();
    error WrongState();
    error Unauthorized();
    error Deadline();
    error TokenAmountMismatch();

    constructor(address token_) EIP712("A423Escrow", "1") {
        if (token_.code.length == 0) revert InvalidTerms();
        token = IERC20(token_);
    }
    function termsDigest(Terms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TERMS_TYPEHASH, t)));
    }
    function getJob(bytes32 id) external view returns (Job memory) { return jobs[id]; }
    /// Payer transaction plus worker EIP712 signature establish bilateral on-chain consent.
    function fund(Terms calldata t, bytes calldata workerSignature) external nonReentrant {
        if (msg.sender != t.payer) revert Unauthorized();
        if (jobs[t.jobId].state != State.None) revert WrongState();
        if (t.jobId == bytes32(0) || t.agreementHash == bytes32(0) || t.amount == 0 || t.worker == address(0) || t.worker == t.payer || t.verifier == address(0) || t.arbitrator == address(0) || t.arbitrator == t.payer || t.arbitrator == t.worker || t.timeoutWorkerBps > 10000) revert InvalidTerms();
        if (t.workDeadline <= block.timestamp || t.reviewDeadline <= t.workDeadline || t.resolutionDeadline <= t.reviewDeadline) revert InvalidTerms();
        bool valid;
        if (t.worker.code.length == 0) { valid = ECDSA.recover(termsDigest(t), workerSignature) == t.worker; }
        else { try IERC1271(t.worker).isValidSignature(termsDigest(t), workerSignature) returns (bytes4 magic) { valid = magic == IERC1271.isValidSignature.selector; } catch { valid = false; } }
        if (!valid) revert Unauthorized();
        jobs[t.jobId] = Job(t, State.Funded, bytes32(0), 0, Proposal(0, 0, address(0), 0, bytes32(0)));
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(t.payer, address(this), t.amount);
        if (token.balanceOf(address(this)) != beforeBalance + t.amount) revert TokenAmountMismatch();
        emit Funded(t.jobId, t.agreementHash, t.payer, t.worker, t.amount);
    }
    function submit(bytes32 id, bytes32 resultHash) external {
        Job storage j = jobs[id];
        if (msg.sender != j.terms.worker) revert Unauthorized();
        if (j.state != State.Funded) revert WrongState();
        if (block.timestamp > j.terms.workDeadline) revert Deadline();
        if (resultHash == bytes32(0)) revert InvalidTerms();
        j.resultHash = resultHash; j.state = State.Submitted;
        emit Submitted(id, resultHash);
    }
    function verify(bytes32 id, bytes32 resultHash) external {
        Job storage j = jobs[id];
        if (msg.sender != j.terms.verifier) revert Unauthorized();
        if (j.state != State.Submitted) revert WrongState();
        if (block.timestamp > j.terms.reviewDeadline) revert Deadline();
        if (resultHash != j.resultHash) revert InvalidTerms();
        j.state = State.Verified; emit Verified(id, resultHash);
    }
    function release(bytes32 id) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.terms.verifier) revert Unauthorized();
        if (j.state != State.Verified) revert WrongState();
        if (block.timestamp > j.terms.resolutionDeadline) revert Deadline();
        _settle(id, j, j.terms.amount, 0);
    }
    function refundExpired(bytes32 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Funded && !((j.state == State.Negotiating || j.state == State.Disputed) && j.resultHash == bytes32(0))) revert WrongState();
        if (block.timestamp <= j.terms.workDeadline) revert Deadline();
        _settle(id, j, 0, 1);
    }
    function dispute(bytes32 id, bytes32 reasonHash) external {
        Job storage j = jobs[id];
        if (msg.sender != j.terms.payer && msg.sender != j.terms.worker && msg.sender != j.terms.verifier) revert Unauthorized();
        if (j.state != State.Submitted && j.state != State.Verified && j.state != State.Negotiating && j.state != State.Funded) revert WrongState();
        if (block.timestamp > j.terms.resolutionDeadline) revert Deadline();
        j.state = State.Disputed; emit Disputed(id, reasonHash);
    }
    function resolve(bytes32 id, uint256 workerAmount) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.terms.arbitrator) revert Unauthorized();
        if (j.state != State.Disputed) revert WrongState();
        if (block.timestamp > j.terms.resolutionDeadline || workerAmount > j.terms.amount) revert InvalidTerms();
        _settle(id, j, workerAmount, 2);
    }
    /// Permissionless liveness fallback; requires an actual transaction after the deadline.
    function timeout(bytes32 id) external nonReentrant {
        Job storage j = jobs[id];
        if ((j.state != State.Submitted && j.state != State.Verified && j.state != State.Disputed && j.state != State.Negotiating) || j.resultHash == bytes32(0)) revert WrongState();
        if (block.timestamp <= j.terms.resolutionDeadline) revert Deadline();
        // Quotient/remainder avoids overflowing amount * bps.
        uint256 amount = (j.terms.amount / 10000) * j.terms.timeoutWorkerBps + ((j.terms.amount % 10000) * j.terms.timeoutWorkerBps) / 10000;
        _settle(id, j, amount, 3);
    }
    /// A published proposal freezes submit/verify/release, but never extends a deadline.
    /// Off-chain claim/evidence bytes are committed through proposalHash.
    function proposeSettlement(bytes32 id, uint64 expectedRevision, uint256 workerAmount, bytes32 proposalHash, uint64 expiresAt) external {
        Job storage j = jobs[id];
        if (msg.sender != j.terms.payer && msg.sender != j.terms.worker) revert Unauthorized();
        if (j.state != State.Funded && j.state != State.Submitted && j.state != State.Verified && j.state != State.Negotiating) revert WrongState();
        if (j.proposal.revision != expectedRevision || workerAmount > j.terms.amount || proposalHash == bytes32(0)) revert InvalidTerms();
        if (j.state == State.Negotiating && j.proposal.proposer == msg.sender) revert Unauthorized();
        if (expiresAt <= block.timestamp || expiresAt > j.terms.resolutionDeadline || block.timestamp > j.terms.resolutionDeadline) revert Deadline();
        j.proposal = Proposal(expectedRevision + 1, expiresAt, msg.sender, workerAmount, proposalHash);
        j.state = State.Negotiating;
        emit SettlementProposed(id, j.proposal.revision, msg.sender, workerAmount, j.terms.amount - workerAmount, proposalHash, expiresAt);
    }
    /// The counterparty's transaction accepts the exact currently published closing allocation.
    function acceptSettlement(bytes32 id, uint64 revision, bytes32 proposalHash) external nonReentrant {
        Job storage j = jobs[id];
        if ((msg.sender != j.terms.payer && msg.sender != j.terms.worker) || msg.sender == j.proposal.proposer) revert Unauthorized();
        _checkProposal(j, revision, proposalHash);
        emit SettlementAccepted(id, revision, proposalHash);
        _settle(id, j, j.proposal.workerAmount, 4);
    }
    function settlementDigest(ClosingSettlement calldata s) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, s)));
    }
    /// Anyone can relay both parties' exact, current, chain/domain-bound signatures.
    function settleByConsent(ClosingSettlement calldata s, bytes calldata payerSignature, bytes calldata workerSignature) external nonReentrant {
        Job storage j = jobs[s.jobId];
        _checkProposal(j, s.escrowVersion, s.proposalHash);
        if (s.agreementHash != j.terms.agreementHash || s.workerAmount != j.proposal.workerAmount || s.payerAmount != j.terms.amount - s.workerAmount || s.expiresAt != j.proposal.expiresAt) revert InvalidTerms();
        bytes32 digest = settlementDigest(s);
        if (!_validSignature(j.terms.payer, digest, payerSignature) || !_validSignature(j.terms.worker, digest, workerSignature)) revert Unauthorized();
        emit SettlementAccepted(s.jobId, s.escrowVersion, s.proposalHash);
        _settle(s.jobId, j, s.workerAmount, 4);
    }
    function _validSignature(address account, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (account.code.length == 0) return ECDSA.recover(digest, signature) == account;
        try IERC1271(account).isValidSignature(digest, signature) returns (bytes4 magic) { return magic == IERC1271.isValidSignature.selector; } catch { return false; }
    }
    function _checkProposal(Job storage j, uint64 revision, bytes32 proposalHash) private view {
        if (j.state != State.Negotiating) revert WrongState();
        if (revision != j.proposal.revision || proposalHash != j.proposal.proposalHash) revert InvalidTerms();
        if (block.timestamp > j.proposal.expiresAt || block.timestamp > j.terms.resolutionDeadline) revert Deadline();
    }
    function _settle(bytes32 id, Job storage j, uint256 workerAmount, uint8 reason) private {
        uint256 payerAmount = j.terms.amount - workerAmount;
        j.state = workerAmount == 0 ? State.Refunded : payerAmount == 0 ? State.Paid : State.Split;
        j.workerPaid = workerAmount;
        if (workerAmount > 0) _transferExact(j.terms.worker, workerAmount);
        if (payerAmount > 0) _transferExact(j.terms.payer, payerAmount);
        emit Settled(id, workerAmount, payerAmount, reason);
    }
    function _transferExact(address to, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (token.balanceOf(address(this)) != beforeBalance - amount || token.balanceOf(to) != beforeRecipient + amount) revert TokenAmountMismatch();
    }
}
