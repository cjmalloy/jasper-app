import type { RPCSchema } from "electrobun/view";

export type ImageTags = {
  server: string[];
  client: string[];
  database: string[];
  ssh: string[];
};

export type SettingsData = Record<string, any>;

export type PtySize = {
  cols: number;
  rows: number;
};

export type JasperRPC = {
  bun: RPCSchema<{
    requests: {
      fetchSettings: {
        params: {};
        response: SettingsData;
      };
      saveSettings: {
        params: { settings: SettingsData };
        response: { success: boolean };
      };
      patchSettings: {
        params: { name: string; value: unknown };
        response: { success: boolean };
      };
      command: {
        params: { command: string; args: unknown[] };
        response: { accepted: boolean };
      };
      openDir: {
        params: { path: string };
        response: { success: boolean };
      };
      fetchLogs: {
        params: {};
        response: { logs: string };
      };
      resizePty: {
        params: PtySize;
        response: { success: boolean };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      finished: string;
      imageTags: ImageTags;
      streamLogs: string;
      updateSettings: SettingsData;
    };
  }>;
};
