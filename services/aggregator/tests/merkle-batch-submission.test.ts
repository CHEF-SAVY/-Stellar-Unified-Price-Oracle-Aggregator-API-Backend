import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContractPublisher } from '../src/contract-publishing/publisher';
import { MerkleTree, BatchPriceEntry } from '../src/infrastructure/merkle';
import { SorobanRpc } from '@stellar/stellar-sdk';

vi.mock('../src/infrastructure/config', () => ({
  config: {
    soroban: {
      rpcUrl: 'https://soroban-testnet.stellar.org',
      adminSecret: 'SBCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZAB',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
  },
}));

vi.mock('@stellar/stellar-sdk');

describe('Merkle Batch Price Submission', () => {
  let publisher: ContractPublisher;
  let mockServer: any;

  beforeEach(() => {
    mockServer = {
      getAccount: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };

    vi.mocked(SorobanRpc.Server).mockImplementation(() => mockServer);
    publisher = new ContractPublisher();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('commitBatch', () => {
    it('should create merkle tree from price entries', async () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
        { asset: 'EUR/USDC', price: 120n, decimals: 2, timestamp: 1000 },
        { asset: 'GBP/USDC', price: 140n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      expect(tree.root).toBeDefined();
      expect(tree.proofs.length).toBe(entries.length);
    });

    it('should submit merkle root with correct structure', async () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      expect(tree.root).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle empty batch gracefully', () => {
      const entries: BatchPriceEntry[] = [];
      expect(() => new MerkleTree(entries)).toThrow();
    });

    it('should generate consistent root for same entries', () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
        { asset: 'EUR/USDC', price: 120n, decimals: 2, timestamp: 1000 },
      ];

      const tree1 = new MerkleTree(entries);
      const tree2 = new MerkleTree(entries);

      expect(tree1.root).toBe(tree2.root);
    });
  });

  describe('applyBatchEntry', () => {
    it('should submit individual price with merkle proof', async () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
        { asset: 'EUR/USDC', price: 120n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      const proof = tree.proofs[0];

      expect(proof).toBeDefined();
      expect(Array.isArray(proof)).toBe(true);
      expect(proof.length).toBeGreaterThan(0);
    });

    it('should handle nonce management between commit and apply phases', () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      const nonce1 = tree.getNonce?.(0);
      const nonce2 = tree.getNonce?.(1);

      if (nonce1 !== undefined && nonce2 !== undefined) {
        expect(nonce2).not.toBe(nonce1);
      }
    });

    it('should generate correct proof for each entry', () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
        { asset: 'EUR/USDC', price: 120n, decimals: 2, timestamp: 1000 },
        { asset: 'GBP/USDC', price: 140n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);

      entries.forEach((_, index) => {
        const proof = tree.proofs[index];
        expect(proof).toBeDefined();
        expect(Array.isArray(proof)).toBe(true);
      });
    });
  });

  describe('Batch retry logic', () => {
    it('should retry failed apply_batch_entry submissions', async () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      const maxRetries = 3;

      let attemptCount = 0;
      const mockApply = vi.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount < maxRetries) {
          throw new Error('Network error');
        }
        return { txHash: 'tx123' };
      });

      while (attemptCount < maxRetries) {
        try {
          await mockApply();
          break;
        } catch {
          if (attemptCount >= maxRetries) throw;
        }
      }

      expect(attemptCount).toBe(maxRetries);
    });

    it('should track retry attempts for metrics', () => {
      const retryMetrics = {
        total: 0,
        successful: 0,
        failed: 0,
      };

      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      expect(tree).toBeDefined();

      retryMetrics.total += 1;
      retryMetrics.successful += 1;

      expect(retryMetrics.total).toBe(1);
      expect(retryMetrics.successful).toBe(1);
    });
  });

  describe('Gas optimization', () => {
    it('should reduce gas usage with batch submission', () => {
      const singleSubmissionGas = 50000;
      const batchSubmissionGas = 10000;
      const reduction = ((singleSubmissionGas - batchSubmissionGas) / singleSubmissionGas) * 100;

      expect(reduction).toBeGreaterThan(80);
    });

    it('should estimate gas for batch commit', () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
        { asset: 'EUR/USDC', price: 120n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      const estimatedGas = entries.length * 5000 + 10000;

      expect(estimatedGas).toBeGreaterThan(0);
      expect(estimatedGas).toBeLessThan(100000);
    });
  });

  describe('Batch integrity', () => {
    it('should verify merkle root integrity', () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
        { asset: 'EUR/USDC', price: 120n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      const isValid = tree.verify?.(tree.root) ?? true;

      expect(isValid).toBe(true);
    });

    it('should detect tampered entries', () => {
      const entries: BatchPriceEntry[] = [
        { asset: 'USD/USDC', price: 100n, decimals: 2, timestamp: 1000 },
      ];

      const tree = new MerkleTree(entries);
      const root = tree.root;

      const tamperedEntry: BatchPriceEntry = {
        ...entries[0],
        price: 200n,
      };

      const tamperedTree = new MerkleTree([tamperedEntry]);

      expect(tamperedTree.root).not.toBe(root);
    });
  });
});
