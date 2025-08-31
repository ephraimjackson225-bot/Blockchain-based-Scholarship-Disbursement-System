;; DisbursementEngine.clar
;; Core contract for automated scholarship disbursements in the Blockchain-based Scholarship System.
;; This contract handles the triggering of payouts to eligible students based on verified achievements
;; and eligibility evaluations. It integrates with FundingPool for fund management, EligibilityEvaluator
;; for checks, and StudentRegistry for profiles. Includes anti-reentrancy, batch processing, time-locks,
;; and governance for robustness.

;; Traits for dependent contracts
(define-trait funding-pool-trait
  (
    (get-balance () (response uint uint))
    (withdraw (uint principal) (response bool uint))
    (get-pool-details (uint) (response {amount: uint, locked-until: uint} uint))
  )
)

(define-trait eligibility-evaluator-trait
  (
    (evaluate-student (principal uint) (response bool uint))
    (get-evaluation-details (principal uint) (response {score: uint, passed: bool, timestamp: uint} uint))
  )
)

(define-trait student-registry-trait
  (
    (get-student-profile (principal) (response {id: uint, verified: bool, achievements-hash: (buff 32)} uint))
  )
)

;; Constants
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INSUFFICIENT-FUNDS u101)
(define-constant ERR-INVALID-STUDENT u102)
(define-constant ERR-NOT-ELIGIBLE u103)
(define-constant ERR-ALREADY-DISBURSED u104)
(define-constant ERR-PAUSED u105)
(define-constant ERR-INVALID-AMOUNT u106)
(define-constant ERR-REENTRANCY u107)
(define-constant ERR-INVALID-POOL u108)
(define-constant ERR-TIME-LOCKED u109)
(define-constant ERR-BATCH-LIMIT u110)
(define-constant ERR-GOVERNANCE u111)
(define-constant ERR-INVALID-PROPOSAL u112)
(define-constant MAX-BATCH-SIZE u50)
(define-constant GOVERNANCE-QUORUM u51) ;; 51% for majority

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var paused bool false)
(define-data-var reentrancy-guard bool false)
(define-data-var total-disbursed uint u0)
(define-data-var disbursement-counter uint u0)
(define-data-var governance-token principal 'SP000000000000000000002Q6VF78.governance-token) ;; Example token principal

;; Data Maps
(define-map disbursements
  { disbursement-id: uint }
  {
    student: principal,
    amount: uint,
    pool-id: uint,
    timestamp: uint,
    status: (string-ascii 20), ;; "pending", "disbursed", "failed", "reverted"
    metadata: (string-utf8 256)
  }
)

(define-map student-disbursement-history
  { student: principal, scholarship-id: uint }
  { last-disbursed: uint, total-received: uint, last-timestamp: uint }
)

(define-map pools-config
  { pool-id: uint }
  {
    min-amount: uint,
    max-amount: uint,
    time-lock: uint, ;; blocks before next disbursement
    evaluator: principal, ;; EligibilityEvaluator contract
    active: bool
  }
)

(define-map governance-proposals
  { proposal-id: uint }
  {
    proposer: principal,
    description: (string-utf8 512),
    votes-for: uint,
    votes-against: uint,
    end-block: uint,
    executed: bool,
    action: (string-ascii 50) ;; e.g., "pause", "update-pool", "change-owner"
  }
)

(define-map governance-votes
  { proposal-id: uint, voter: principal }
  { vote: bool, weight: uint }
)

;; Private Functions
(define-private (check-reentrancy)
  (if (var-get reentrancy-guard)
    (err ERR-REENTRANCY)
    (begin
      (var-set reentrancy-guard true)
      (ok true)
    )
  )
)

(define-private (release-reentrancy)
  (var-set reentrancy-guard false)
)

(define-private (is-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (get-governance-balance (account principal))
  ;; Mocked call to governance token balance; in real, use (contract-call? governance-token get-balance account)
  (ok u100) ;; Placeholder
)

;; Public Functions
(define-public (disburse-to-student (student principal) (amount uint) (pool-id uint) (metadata (string-utf8 256)))
  (let
    (
      (pool-config (unwrap! (map-get? pools-config {pool-id: pool-id}) (err ERR-INVALID-POOL)))
      (student-profile (contract-call? .student-registry get-student-profile student))
      (evaluation (contract-call? (as-contract (unwrap! (get evaluator pool-config) (err ERR-INVALID-POOL))) evaluate-student student pool-id))
      (funding-pool (as-contract .funding-pool))
      (history (default-to {last-disbursed: u0, total-received: u0, last-timestamp: u0} (map-get? student-disbursement-history {student: student, scholarship-id: pool-id})))
      (current-block block-height)
    )
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (check-reentrancy) (err ERR-REENTRANCY))
    (asserts! (get active pool-config) (err ERR-INVALID-POOL))
    (asserts! (>= amount (get min-amount pool-config)) (err ERR-INVALID-AMOUNT))
    (asserts! (<= amount (get max-amount pool-config)) (err ERR-INVALID-AMOUNT))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (is-ok student-profile) (err ERR-INVALID-STUDENT))
    (asserts! (get verified (unwrap! student-profile (err ERR-INVALID-STUDENT))) (err ERR-INVALID-STUDENT))
    (asserts! (is-ok evaluation) (err ERR-NOT-ELIGIBLE))
    (asserts! (get passed (unwrap! (contract-call? (as-contract (get evaluator pool-config)) get-evaluation-details student pool-id) (err ERR-NOT-ELIGIBLE))) (err ERR-NOT-ELIGIBLE))
    (asserts! (>= current-block (+ (get last-timestamp history) (get time-lock pool-config))) (err ERR-TIME-LOCKED))
    (let
      (
        (fund-balance (unwrap! (contract-call? funding-pool get-balance) (err ERR-INSUFFICIENT-FUNDS)))
        (pool-details (unwrap! (contract-call? funding-pool get-pool-details pool-id) (err ERR-INVALID-POOL)))
      )
      (asserts! (>= fund-balance amount) (err ERR-INSUFFICIENT-FUNDS))
      (asserts! (>= (get amount pool-details) amount) (err ERR-INSUFFICIENT-FUNDS))
      (asserts! (>= current-block (get locked-until pool-details)) (err ERR-TIME-LOCKED))
      (try! (contract-call? funding-pool withdraw amount student))
      (let ((new-id (+ (var-get disbursement-counter) u1)))
        (map-set disbursements {disbursement-id: new-id}
          {
            student: student,
            amount: amount,
            pool-id: pool-id,
            timestamp: current-block,
            status: "disbursed",
            metadata: metadata
          }
        )
        (map-set student-disbursement-history {student: student, scholarship-id: pool-id}
          {
            last-disbursed: amount,
            total-received: (+ (get total-received history) amount),
            last-timestamp: current-block
          }
        )
        (var-set disbursement-counter new-id)
        (var-set total-disbursed (+ (var-get total-disbursed) amount))
        (print {event: "disbursement", id: new-id, student: student, amount: amount})
        (release-reentrancy)
        (ok new-id)
      )
    )
  )
)

(define-public (batch-disburse (students (list 50 principal)) (amounts (list 50 uint)) (pool-id uint) (metadata (string-utf8 256)))
  (let ((len (len students)))
    (asserts! (<= len MAX-BATCH-SIZE) (err ERR-BATCH-LIMIT))
    (asserts! (is-eq len (len amounts)) (err ERR-INVALID-AMOUNT))
    (fold batch-disburse-iter (zip students amounts) (ok u0 pool-id metadata))
  )
)

(define-private (batch-disburse-iter (student principal) (amount uint) (prev (response uint uint)) (pool-id uint) (metadata (string-utf8 256)))
  (match prev
    success (disburse-to-student student amount pool-id metadata)
    error (err error)
  )
)

(define-public (pause-contract)
  (begin
    (asserts! (is-owner tx-sender) (err ERR-UNAUTHORIZED))
    (var-set paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-owner tx-sender) (err ERR-UNAUTHORIZED))
    (var-set paused false)
    (ok true)
  )
)

(define-public (update-pool-config (pool-id uint) (min-amount uint) (max-amount uint) (time-lock uint) (evaluator principal) (active bool))
  (begin
    (asserts! (is-owner tx-sender) (err ERR-UNAUTHORIZED))
    (map-set pools-config {pool-id: pool-id}
      {min-amount: min-amount, max-amount: max-amount, time-lock: time-lock, evaluator: evaluator, active: active}
    )
    (ok true)
  )
)

(define-public (create-governance-proposal (description (string-utf8 512)) (action (string-ascii 50)) (duration uint))
  (let ((proposal-id (+ (var-get disbursement-counter) u1)) ;; Reuse counter for simplicity
        (end-block (+ block-height duration)))
    (asserts! (> (unwrap! (get-governance-balance tx-sender) (err ERR-GOVERNANCE)) u0) (err ERR-UNAUTHORIZED))
    (map-set governance-proposals {proposal-id: proposal-id}
      {proposer: tx-sender, description: description, votes-for: u0, votes-against: u0, end-block: end-block, executed: false, action: action}
    )
    (var-set disbursement-counter proposal-id) ;; Increment
    (ok proposal-id)
  )
)

(define-public (vote-on-proposal (proposal-id uint) (vote bool))
  (let ((proposal (unwrap! (map-get? governance-proposals {proposal-id: proposal-id}) (err ERR-INVALID-PROPOSAL)))
        (weight (unwrap! (get-governance-balance tx-sender) (err ERR-GOVERNANCE))))
    (asserts! (< block-height (get end-block proposal)) (err ERR-INVALID-PROPOSAL))
    (asserts! (is-none (map-get? governance-votes {proposal-id: proposal-id, voter: tx-sender})) (err ERR-ALREADY-DISBURSED))
    (map-set governance-votes {proposal-id: proposal-id, voter: tx-sender} {vote: vote, weight: weight})
    (if vote
      (map-set governance-proposals {proposal-id: proposal-id} (merge proposal {votes-for: (+ (get votes-for proposal) weight)}))
      (map-set governance-proposals {proposal-id: proposal-id} (merge proposal {votes-against: (+ (get votes-against proposal) weight)}))
    )
    (ok true)
  )
)

(define-public (execute-proposal (proposal-id uint))
  (let ((proposal (unwrap! (map-get? governance-proposals {proposal-id: proposal-id}) (err ERR-INVALID-PROPOSAL)))
        (total-votes (+ (get votes-for proposal) (get votes-against proposal))))
    (asserts! (>= block-height (get end-block proposal)) (err ERR-INVALID-PROPOSAL))
    (asserts! (not (get executed proposal)) (err ERR-ALREADY-DISBURSED))
    (asserts! (> (* (get votes-for proposal) u100) (* total-votes GOVERNANCE-QUORUM)) (err ERR-GOVERNANCE))
    (map-set governance-proposals {proposal-id: proposal-id} (merge proposal {executed: true}))
    (match (get action proposal)
      "pause" (var-set paused true)
      "unpause" (var-set paused false)
      ;; Add more actions as needed, e.g., "update-owner"
      (err ERR-INVALID-PROPOSAL)
    )
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-disbursement-details (disbursement-id uint))
  (map-get? disbursements {disbursement-id: disbursement-id})
)

(define-read-only (get-student-history (student principal) (scholarship-id uint))
  (map-get? student-disbursement-history {student: student, scholarship-id: scholarship-id})
)

(define-read-only (get-pool-config (pool-id uint))
  (map-get? pools-config {pool-id: pool-id})
)

(define-read-only (get-total-disbursed)
  (var-get total-disbursed)
)

(define-read-only (is-contract-paused)
  (var-get paused)
)

(define-read-only (get-proposal (proposal-id uint))
  (map-get? governance-proposals {proposal-id: proposal-id})
)