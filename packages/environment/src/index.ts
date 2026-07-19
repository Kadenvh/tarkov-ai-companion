// @tac/environment — M6 Environment & Meta (see docs/spec/SPEC-4.md, CONTRACTS §1/§5.4/§9).
export { REPO_ROOT, DEFAULT_BACKUP_DIR, defaultSettingsDir } from "./paths.js";
export {
  SETTINGS_FILES,
  GraphicsSettings,
  GameSettings,
  PostFxSettings,
  parseSettingsJson,
  loadEftSettings,
  getSetting,
  type SettingsFileName,
  type SettingValue,
  type EftSettings,
} from "./eft-settings.js";
export {
  PROFILES,
  META_PROFILE,
  getProfile,
  diffSettings,
  diffAllProfiles,
  type ProfileSetting,
  type RecommendationProfile,
  type SettingDiff,
} from "./profiles.js";
export {
  ADS_ONE_TO_ONE_COEFFICIENT,
  ADS_ONE_TO_ONE_TOLERANCE,
  adsOneToOne,
  adsMatchesOneToOne,
  readSensitivity,
  auditConfig,
  type AuditSeverity,
  type AuditFinding,
  type AuditConfirmation,
  type SensitivityReadout,
  type AuditResult,
} from "./audit.js";
export {
  EFT_PROCESS_NAME,
  GameRunningError,
  isEftRunning,
  applyProfile,
  listBackups,
  restoreBackup,
  type BackupManifest,
  type ApplyOptions,
  type ApplyResult,
  type RestoreOptions,
} from "./apply.js";
export {
  parseGpuCsv,
  detectGpu,
  nvidiaRecommendations,
  nvidiaReport,
  type GpuInfo,
  type NvidiaSmiRunner,
  type NvidiaRecommendation,
  type NvidiaReport,
} from "./nvidia.js";
export {
  parsePresentMonCsv,
  percentile,
  summarizeRun,
  toPerfSampleRow,
  detectRegression,
  type RunSummary,
  type ParseOptions,
  type PerfSampleRow,
  type RegressionOptions,
  type RegressionResult,
} from "./presentmon.js";
export {
  classifyAmmoTier,
  buildAmmoTable,
  ammoByCaliber,
  topAmmoForBriefing,
  type AmmoTier,
  type AmmoEntry,
} from "./ammo.js";
export {
  perfAdvice,
  PHYSICAL_CORE_ON_THRESHOLD,
  RAM_CLEANER_OFF_GB,
  RAM_CLEANER_ON_GB,
  type HardwareFacts,
  type PerfSettingAdvice,
} from "./perf-advice.js";
