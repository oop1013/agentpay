/**
 * Express module augmentation for req.agentpay — populated by the paywall middleware
 * after successful payment verification.
 */
declare global {
  namespace Express {
    interface Request {
      agentpay?: {
        serviceId: string;
        callerWallet: string;
        providerWallet: string;
        grossAmount: number;
        platformFee: number;
        providerNet: number;
        feeBps: number;
        verified: true;
      };
    }
  }
}

export {};
