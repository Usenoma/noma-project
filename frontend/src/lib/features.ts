// Post-launch feature flags. All are OFF by default and must stay off at launch.
// Enable per environment with NEXT_PUBLIC_FEATURE_* = "1".
export const FEATURES = {
  ghostCheckout: process.env.NEXT_PUBLIC_FEATURE_GHOST_CHECKOUT === "1",
  capsules: process.env.NEXT_PUBLIC_FEATURE_CAPSULES === "1",
  exposureReceipt: process.env.NEXT_PUBLIC_FEATURE_EXPOSURE_RECEIPT === "1",
  subscriptionGuardian: process.env.NEXT_PUBLIC_FEATURE_SUBSCRIPTION_GUARDIAN === "1",
  ghostAgent: process.env.NEXT_PUBLIC_FEATURE_GHOST_AGENT === "1",
} as const;
