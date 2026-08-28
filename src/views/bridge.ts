import { Electroview } from "electrobun/view";
import type {
  ImageTags,
  JasperRPC,
  PtySize,
  SettingsData,
} from "../shared/rpc";

type Listener<T> = (event: undefined, value: T) => void;

function createChannel<T>(replayLatest = false) {
  const listeners = new Set<Listener<T>>();
  let latest: T | undefined;
  let hasLatest = false;

  return {
    emit(value: T) {
      latest = value;
      hasLatest = true;
      for (const listener of listeners) listener(undefined, value);
    },
    listen(listener: Listener<T>) {
      listeners.add(listener);
      if (replayLatest && hasLatest) listener(undefined, latest as T);
    },
  };
}

const finished = createChannel<string>();
const imageTags = createChannel<ImageTags>(true);
const streamLogs = createChannel<string>();
const updateSettings = createChannel<SettingsData>(true);

const rpc = Electroview.defineRPC<JasperRPC>({
  handlers: {
    requests: {},
    messages: {
      finished: (command) => finished.emit(command),
      imageTags: (tags) => imageTags.emit(tags),
      streamLogs: (logs) => streamLogs.emit(logs),
      updateSettings: (settings) => updateSettings.emit(settings),
    },
  },
});

new Electroview({ rpc });

function run<T>(request: Promise<T>, onSuccess?: (value: T) => void) {
  void request.then(onSuccess).catch((error) => console.error(error));
}

const jasperAPI = {
  handleSettings: updateSettings.listen,
  updateImageTags: imageTags.listen,
  streamLogs: streamLogs.listen,
  notifyFinished: finished.listen,

  fetchLogs: () =>
    run(rpc.request.fetchLogs({}), ({ logs }) => {
      if (logs) streamLogs.emit(logs);
    }),
  resizePty: (size: PtySize) => run(rpc.request.resizePty(size)),
  fetchSettings: () =>
    run(rpc.request.fetchSettings({}), (settings) =>
      updateSettings.emit(settings),
    ),
  saveSettings: (settings: SettingsData) =>
    run(rpc.request.saveSettings({ settings })),
  patchSettings: (patch: { name: string; value: unknown }) =>
    run(rpc.request.patchSettings(patch)),
  openDir: (path: string) => run(rpc.request.openDir({ path })),
  command: (command: string, args: unknown[] = []) =>
    run(rpc.request.command({ command, args })),
};

Object.defineProperty(window, "jasperAPI", {
  value: jasperAPI,
  writable: false,
});

declare global {
  interface Window {
    jasperAPI: typeof jasperAPI;
  }
}
