import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk';

/** Applied last on every Query, including resume/rebuild and discovery. */
export function isolatedClaudeOptions() {
  return {
    tools: [],
    allowedTools: [],
    disallowedTools: [],
    plugins: [],
    agents: {},
    settingSources: [],
    strictMcpConfig: true,
    allowDangerouslySkipPermissions: false,
    enableFileCheckpointing: false,
    hooks: {},
  } satisfies Partial<Options>;
}

export function isolatedClaudeSettings(settings: Settings = {}): Settings {
  return {
    ...settings,
    disableAllHooks: true,
    disableClaudeAiConnectors: true,
    disableRemoteControl: true,
    disableSkillShellExecution: true,
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
    enabledPlugins: {},
  };
}
