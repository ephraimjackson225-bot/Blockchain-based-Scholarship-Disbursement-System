// DisbursementEngine.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface DisbursementRecord {
  student: string;
  amount: number;
  poolId: number;
  timestamp: number;
  status: string;
  metadata: string;
}

interface StudentHistory {
  lastDisbursed: number;
  totalReceived: number;
  lastTimestamp: number;
}

interface PoolConfig {
  minAmount: number;
  maxAmount: number;
  timeLock: number;
  evaluator: string;
  active: boolean;
}

interface GovernanceProposal {
  proposer: string;
  description: string;
  votesFor: number;
  votesAgainst: number;
  endBlock: number;
  executed: boolean;
  action: string;
}

interface ContractState {
  owner: string;
  paused: boolean;
  reentrancyGuard: boolean;
  totalDisbursed: number;
  disbursementCounter: number;
  governanceToken: string;
  disbursements: Map<number, DisbursementRecord>;
  studentDisbursementHistory: Map<string, StudentHistory>; // Key as `${student}_${scholarshipId}`
  poolsConfig: Map<number, PoolConfig>;
  governanceProposals: Map<number, GovernanceProposal>;
  governanceVotes: Map<string, { vote: boolean; weight: number }>; // Key as `${proposalId}_${voter}`
}

// Mock trait implementations
class MockFundingPool {
  balances: Map<string, number> = new Map([["pool", 100000]]);
  poolDetails: Map<number, { amount: number; lockedUntil: number }> = new Map([
    [1, { amount: 50000, lockedUntil: 0 }],
  ]);

  getBalance(): ClarityResponse<number> {
    return { ok: true, value: this.balances.get("pool") ?? 0 };
  }

  withdraw(amount: number, recipient: string): ClarityResponse<boolean> {
    const current = this.balances.get("pool") ?? 0;
    if (current < amount) return { ok: false, value: 101 };
    this.balances.set("pool", current - amount);
    return { ok: true, value: true };
  }

  getPoolDetails(poolId: number): ClarityResponse<{ amount: number; lockedUntil: number }> {
    const details = this.poolDetails.get(poolId);
    return details ? { ok: true, value: details } : { ok: false, value: 108 };
  }
}

class MockEligibilityEvaluator {
  evaluations: Map<string, { score: number; passed: boolean; timestamp: number }> = new Map();

  evaluateStudent(student: string, poolId: number): ClarityResponse<boolean> {
    const key = `${student}_${poolId}`;
    const evaluation = this.evaluations.get(key);
    return evaluation ? { ok: true, value: evaluation.passed } : { ok: false, value: 103 };
  }

  getEvaluationDetails(student: string, poolId: number): ClarityResponse<{ score: number; passed: boolean; timestamp: number }> {
    const key = `${student}_${poolId}`;
    const evaluation = this.evaluations.get(key);
    return evaluation ? { ok: true, value: evaluation } : { ok: false, value: 103 };
  }
}

class MockStudentRegistry {
  profiles: Map<string, { id: number; verified: boolean; achievementsHash: string }> = new Map();

  getStudentProfile(student: string): ClarityResponse<{ id: number; verified: boolean; achievementsHash: string }> {
    const profile = this.profiles.get(student);
    return profile ? { ok: true, value: profile } : { ok: false, value: 102 };
  }
}

// Mock contract implementation
class DisbursementEngineMock {
  private state: ContractState = {
    owner: "deployer",
    paused: false,
    reentrancyGuard: false,
    totalDisbursed: 0,
    disbursementCounter: 0,
    governanceToken: "governance-token",
    disbursements: new Map(),
    studentDisbursementHistory: new Map(),
    poolsConfig: new Map(),
    governanceProposals: new Map(),
    governanceVotes: new Map(),
  };

  private fundingPool: MockFundingPool = new MockFundingPool();
  private eligibilityEvaluator: Map<number, MockEligibilityEvaluator> = new Map();
  private studentRegistry: MockStudentRegistry = new MockStudentRegistry();

  private ERR_UNAUTHORIZED = 100;
  private ERR_INSUFFICIENT_FUNDS = 101;
  private ERR_INVALID_STUDENT = 102;
  private ERR_NOT_ELIGIBLE = 103;
  private ERR_ALREADY_DISBURSED = 104;
  private ERR_PAUSED = 105;
  private ERR_INVALID_AMOUNT = 106;
  private ERR_REENTRANCY = 107;
  private ERR_INVALID_POOL = 108;
  private ERR_TIME_LOCKED = 109;
  private ERR_BATCH_LIMIT = 110;
  private ERR_GOVERNANCE = 111;
  private ERR_INVALID_PROPOSAL = 112;
  private MAX_BATCH_SIZE = 50;
  private GOVERNANCE_QUORUM = 51;

  // Helper to get current block (mocked)
  private currentBlock = 1000;

  setCurrentBlock(block: number) {
    this.currentBlock = block;
  }

  // Mock governance balance
  private governanceBalances: Map<string, number> = new Map([["deployer", 100], ["voter1", 50]]);

  private checkReentrancy(): ClarityResponse<boolean> {
    if (this.state.reentrancyGuard) {
      return { ok: false, value: this.ERR_REENTRANCY };
    }
    this.state.reentrancyGuard = true;
    return { ok: true, value: true };
  }

  private releaseReentrancy() {
    this.state.reentrancyGuard = false;
  }

  private isOwner(caller: string): boolean {
    return caller === this.state.owner;
  }

  private getGovernanceBalance(account: string): ClarityResponse<number> {
    return { ok: true, value: this.governanceBalances.get(account) ?? 0 };
  }

  disburseToStudent(caller: string, student: string, amount: number, poolId: number, metadata: string): ClarityResponse<number> {
    if (!this.isOwner(caller)) {
      // For testing, assume caller is authorized if needed; but function doesn't check caller
    }
    if (this.state.paused) return { ok: false, value: this.ERR_PAUSED };
    const reentrancy = this.checkReentrancy();
    if (!reentrancy.ok) return reentrancy as ClarityResponse<number>;

    const poolConfig = this.state.poolsConfig.get(poolId);
    if (!poolConfig || !poolConfig.active) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INVALID_POOL };
    }

    const evaluator = this.eligibilityEvaluator.get(poolId) ?? new MockEligibilityEvaluator();
    this.eligibilityEvaluator.set(poolId, evaluator);

    const studentProfile = this.studentRegistry.getStudentProfile(student);
    if (!studentProfile.ok) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INVALID_STUDENT };
    }
    if (!studentProfile.value.verified) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INVALID_STUDENT };
    }

    const evaluation = evaluator.evaluateStudent(student, poolId);
    if (!evaluation.ok || !evaluation.value) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_NOT_ELIGIBLE };
    }

    const evalDetails = evaluator.getEvaluationDetails(student, poolId);
    if (!evalDetails.ok || !evalDetails.value.passed) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_NOT_ELIGIBLE };
    }

    const historyKey = `${student}_${poolId}`;
    const history = this.state.studentDisbursementHistory.get(historyKey) ?? { lastDisbursed: 0, totalReceived: 0, lastTimestamp: 0 };

    if (this.currentBlock < history.lastTimestamp + poolConfig.timeLock) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_TIME_LOCKED };
    }

    if (amount < poolConfig.minAmount || amount > poolConfig.maxAmount || amount <= 0) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }

    const fundBalance = this.fundingPool.getBalance();
    if (!fundBalance.ok || fundBalance.value < amount) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }

    const poolDetails = this.fundingPool.getPoolDetails(poolId);
    if (!poolDetails.ok || poolDetails.value.amount < amount) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }
    if (this.currentBlock < poolDetails.value.lockedUntil) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_TIME_LOCKED };
    }

    const withdraw = this.fundingPool.withdraw(amount, student);
    if (!withdraw.ok) {
      this.releaseReentrancy();
      return { ok: false, value: this.ERR_INSUFFICIENT_FUNDS };
    }

    const newId = this.state.disbursementCounter + 1;
    this.state.disbursements.set(newId, {
      student,
      amount,
      poolId,
      timestamp: this.currentBlock,
      status: "disbursed",
      metadata,
    });

    this.state.studentDisbursementHistory.set(historyKey, {
      lastDisbursed: amount,
      totalReceived: history.totalReceived + amount,
      lastTimestamp: this.currentBlock,
    });

    this.state.disbursementCounter = newId;
    this.state.totalDisbursed += amount;

    this.releaseReentrancy();
    return { ok: true, value: newId };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (!this.isOwner(caller)) return { ok: false, value: this.ERR_UNAUTHORIZED };
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (!this.isOwner(caller)) return { ok: false, value: this.ERR_UNAUTHORIZED };
    this.state.paused = false;
    return { ok: true, value: true };
  }

  updatePoolConfig(caller: string, poolId: number, minAmount: number, maxAmount: number, timeLock: number, evaluator: string, active: boolean): ClarityResponse<boolean> {
    if (!this.isOwner(caller)) return { ok: false, value: this.ERR_UNAUTHORIZED };
    this.state.poolsConfig.set(poolId, { minAmount, maxAmount, timeLock, evaluator, active });
    return { ok: true, value: true };
  }

  createGovernanceProposal(caller: string, description: string, action: string, duration: number): ClarityResponse<number> {
    const balance = this.getGovernanceBalance(caller);
    if (!balance.ok || balance.value <= 0) return { ok: false, value: this.ERR_UNAUTHORIZED };

    const proposalId = this.state.disbursementCounter + 1; // Reuse counter
    const endBlock = this.currentBlock + duration;

    this.state.governanceProposals.set(proposalId, {
      proposer: caller,
      description,
      votesFor: 0,
      votesAgainst: 0,
      endBlock,
      executed: false,
      action,
    });

    this.state.disbursementCounter = proposalId;
    return { ok: true, value: proposalId };
  }

  voteOnProposal(caller: string, proposalId: number, vote: boolean): ClarityResponse<boolean> {
    const proposal = this.state.governanceProposals.get(proposalId);
    if (!proposal) return { ok: false, value: this.ERR_INVALID_PROPOSAL };
    if (this.currentBlock >= proposal.endBlock) return { ok: false, value: this.ERR_INVALID_PROPOSAL };

    const voteKey = `${proposalId}_${caller}`;
    if (this.state.governanceVotes.has(voteKey)) return { ok: false, value: this.ERR_ALREADY_DISBURSED };

    const weightRes = this.getGovernanceBalance(caller);
    if (!weightRes.ok) return { ok: false, value: this.ERR_GOVERNANCE };
    const weight = weightRes.value;

    this.state.governanceVotes.set(voteKey, { vote, weight });

    if (vote) {
      proposal.votesFor += weight;
    } else {
      proposal.votesAgainst += weight;
    }
    this.state.governanceProposals.set(proposalId, proposal);

    return { ok: true, value: true };
  }

  executeProposal(caller: string, proposalId: number): ClarityResponse<boolean> {
    const proposal = this.state.governanceProposals.get(proposalId);
    if (!proposal) return { ok: false, value: this.ERR_INVALID_PROPOSAL };
    if (this.currentBlock < proposal.endBlock) return { ok: false, value: this.ERR_INVALID_PROPOSAL };
    if (proposal.executed) return { ok: false, value: this.ERR_ALREADY_DISBURSED };

    const totalVotes = proposal.votesFor + proposal.votesAgainst;
    if ((proposal.votesFor * 100) <= (totalVotes * this.GOVERNANCE_QUORUM)) return { ok: false, value: this.ERR_GOVERNANCE };

    proposal.executed = true;
    this.state.governanceProposals.set(proposalId, proposal);

    switch (proposal.action) {
      case "pause":
        this.state.paused = true;
        break;
      case "unpause":
        this.state.paused = false;
        break;
      default:
        return { ok: false, value: this.ERR_INVALID_PROPOSAL };
    }

    return { ok: true, value: true };
  }

  getDisbursementDetails(disbursementId: number): ClarityResponse<DisbursementRecord | null> {
    return { ok: true, value: this.state.disbursements.get(disbursementId) ?? null };
  }

  getStudentHistory(student: string, scholarshipId: number): ClarityResponse<StudentHistory | null> {
    const key = `${student}_${scholarshipId}`;
    return { ok: true, value: this.state.studentDisbursementHistory.get(key) ?? null };
  }

  getPoolConfig(poolId: number): ClarityResponse<PoolConfig | null> {
    return { ok: true, value: this.state.poolsConfig.get(poolId) ?? null };
  }

  getTotalDisbursed(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalDisbursed };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getProposal(proposalId: number): ClarityResponse<GovernanceProposal | null> {
    return { ok: true, value: this.state.governanceProposals.get(proposalId) ?? null };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  student1: "student1",
  student2: "student2",
  voter1: "voter1",
};

describe("DisbursementEngine Contract", () => {
  let contract: DisbursementEngineMock;

  beforeEach(() => {
    contract = new DisbursementEngineMock();
    contract.setCurrentBlock(1000);

    // Setup mocks
    contract.studentRegistry.profiles.set(accounts.student1, { id: 1, verified: true, achievementsHash: "hash1" });
    contract.studentRegistry.profiles.set(accounts.student2, { id: 2, verified: true, achievementsHash: "hash2" });

    const evaluator1 = new MockEligibilityEvaluator();
    evaluator1.evaluations.set(`${accounts.student1}_1`, { score: 90, passed: true, timestamp: 900 });
    evaluator1.evaluations.set(`${accounts.student2}_1`, { score: 85, passed: true, timestamp: 900 });
    contract.eligibilityEvaluator.set(1, evaluator1);

    // Setup pool config
    contract.updatePoolConfig(accounts.deployer, 1, 100, 1000, 100, "evaluator1", true);
    vi.resetAllMocks();
  });

  it("should initialize correctly", () => {
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
    expect(contract.getTotalDisbursed()).toEqual({ ok: true, value: 0 });
  });

  it("should disburse to eligible student", () => {
    const result = contract.disburseToStudent(accounts.deployer, accounts.student1, 500, 1, "Scholarship Q3");
    expect(result).toEqual({ ok: true, value: 1 });

    const details = contract.getDisbursementDetails(1);
    expect(details.value).toEqual(expect.objectContaining({ student: accounts.student1, amount: 500, status: "disbursed" }));

    const history = contract.getStudentHistory(accounts.student1, 1);
    expect(history.value).toEqual({ lastDisbursed: 500, totalReceived: 500, lastTimestamp: 1000 });

    expect(contract.getTotalDisbursed()).toEqual({ ok: true, value: 500 });
  });

  it("should prevent disbursement if paused", () => {
    contract.pauseContract(accounts.deployer);
    const result = contract.disburseToStudent(accounts.deployer, accounts.student1, 500, 1, "Test");
    expect(result).toEqual({ ok: false, value: 105 });
  });

  it("should prevent disbursement to ineligible student", () => {
    const evaluator = contract.eligibilityEvaluator.get(1)!;
    evaluator.evaluations.set(`${accounts.student1}_1`, { score: 50, passed: false, timestamp: 900 });
    const result = contract.disburseToStudent(accounts.deployer, accounts.student1, 500, 1, "Test");
    expect(result).toEqual({ ok: false, value: 103 });
  });

  it("should enforce time lock", () => {
    contract.disburseToStudent(accounts.deployer, accounts.student1, 500, 1, "First");
    contract.setCurrentBlock(1050); // Less than 100 blocks after 1000
    const result = contract.disburseToStudent(accounts.deployer, accounts.student1, 300, 1, "Second");
    expect(result).toEqual({ ok: false, value: 109 });

    contract.setCurrentBlock(1101);
    const secondResult = contract.disburseToStudent(accounts.deployer, accounts.student1, 300, 1, "Second");
    expect(secondResult).toEqual({ ok: true, value: 2 });
  });

  it("should prevent reentrancy", () => {
    contract["state"].reentrancyGuard = true; // Simulate reentrancy
    const result = contract.disburseToStudent(accounts.deployer, accounts.student1, 500, 1, "Test");
    expect(result).toEqual({ ok: false, value: 107 });
  });

  it("should create and vote on governance proposal", () => {
    const createResult = contract.createGovernanceProposal(accounts.deployer, "Pause contract for maintenance", "pause", 100);
    expect(createResult).toEqual({ ok: true, value: 1 });

    const voteResult = contract.voteOnProposal(accounts.voter1, 1, true);
    expect(voteResult).toEqual({ ok: true, value: true });

    contract.setCurrentBlock(1200); // After end block 1000 + 100 = 1100
    const executeResult = contract.executeProposal(accounts.deployer, 1);
    expect(executeResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });
  });

  it("should fail execution if quorum not met", () => {
    contract.createGovernanceProposal(accounts.deployer, "Test", "pause", 100);
    contract.voteOnProposal(accounts.voter1, 1, false); // 50 against, deployer didn't vote
    contract.setCurrentBlock(1200);
    const executeResult = contract.executeProposal(accounts.deployer, 1);
    expect(executeResult).toEqual({ ok: false, value: 111 });
  });

  it("should prevent double voting", () => {
    contract.createGovernanceProposal(accounts.deployer, "Test", "pause", 100);
    contract.voteOnProposal(accounts.voter1, 1, true);
    const secondVote = contract.voteOnProposal(accounts.voter1, 1, false);
    expect(secondVote).toEqual({ ok: false, value: 104 });
  });
});