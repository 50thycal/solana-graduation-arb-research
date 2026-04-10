// Re-export StrategyManager as the primary trading orchestrator.
// TradingEngine has been replaced by StrategyManager which supports
// multiple parallel strategy configs for paper trading comparison.
export { StrategyManager } from './strategy-manager';
export type { StrategyInfo } from './strategy-manager';
