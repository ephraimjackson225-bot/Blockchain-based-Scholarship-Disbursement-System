# 📚 Blockchain-based Scholarship Disbursement System

Welcome to a transparent and corruption-resistant way to automate scholarship disbursements! This Web3 project uses the Stacks blockchain and Clarity smart contracts to verify academic achievements on-chain, ensuring funds are allocated fairly based on verifiable criteria. By eliminating manual oversight and administrative biases, it solves real-world problems like corruption, delays, and fraud in scholarship programs, particularly in educational institutions or nonprofit organizations.

## ✨ Features

🔍 On-chain verification of academic achievements (e.g., grades, certifications) using trusted oracles or issuers  
💰 Automated disbursement of scholarship funds from pooled resources  
📝 Secure student applications with immutable records  
✅ Rule-based eligibility checks to prevent favoritism  
🔒 Governance for updating criteria and managing funds transparently  
📊 Audit trails for all transactions and verifications  
🚫 Anti-fraud mechanisms like unique achievement hashes and duplicate prevention  
🌐 Integration with external data sources via oracles for real-time validation  

## 🛠 How It Works

This system leverages 8 interconnected Clarity smart contracts to create a decentralized, automated pipeline for scholarships. Funds are held in escrow-like pools, achievements are verified immutably, and disbursements happen automatically when criteria are met.

**For Students**  
- Register your profile and submit academic achievements (e.g., upload hashed transcripts).  
- Apply for scholarships by calling the application contract with your details.  
- Once verified and eligible, funds are automatically disbursed to your wallet.  

**For Educational Institutions/Issuers**  
- Use the achievement issuer contract to certify and hash student accomplishments on-chain.  
- Integrate with oracles to pull real-world data like GPAs or exam results.  

**For Donors/Administrators**  
- Deposit funds into scholarship pools via the funding contract.  
- Set or update eligibility rules through governance votes.  
- Monitor disbursements and audits for transparency.  

**For Verifiers/Auditors**  
- Query the system to verify any student's achievements or disbursement history.  
- Check eligibility evaluations to ensure no corruption occurred.  

The process is end-to-end on-chain: Achievements are hashed and timestamped, applications are evaluated against predefined rules, and payouts are triggered without human intervention.

## 📑 Smart Contracts Overview

The project consists of 8 Clarity smart contracts, each handling a specific aspect for modularity and security:

1. **StudentRegistry.clar**: Manages student profiles, including registration, updates, and unique identifiers to prevent duplicates.  
2. **AchievementIssuer.clar**: Allows trusted issuers (e.g., schools) to submit and verify hashed academic achievements with timestamps.  
3. **OracleIntegrator.clar**: Interfaces with external oracles for real-time data validation (e.g., confirming grades from APIs).  
4. **ScholarshipApplication.clar**: Handles application submissions, linking them to student profiles and achievements.  
5. **EligibilityEvaluator.clar**: Automates checks against rules (e.g., GPA thresholds, enrollment status) using on-chain logic.  
6. **FundingPool.clar**: Manages scholarship funds, including deposits, withdrawals, and escrow for pending disbursements.  
7. **DisbursementEngine.clar**: Triggers automatic payouts to eligible students once evaluations pass, with anti-reentrancy safeguards.  
8. **GovernanceBoard.clar**: Enables decentralized governance for updating rules, adding issuers, or resolving disputes via token-based voting.

These contracts interact via cross-contract calls in Clarity, ensuring atomicity and reducing attack surfaces. For example, the DisbursementEngine calls the EligibilityEvaluator before releasing funds from the FundingPool.

## 🚀 Getting Started

Deploy on Stacks testnet using Clarinet. Sample code snippets for key functions (e.g., `register-student`, `verify-achievement`, `disburse-funds`) can be found in the contracts folder. This project promotes educational equity by making scholarships merit-based and tamper-proof!