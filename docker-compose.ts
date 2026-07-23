import { spawn as ptySpawn } from '@lydell/node-pty';
import { EventEmitter } from 'events';

type ComposeSettings = {
  cfToken?: string;
  ngrokToken?: string;
};

type PtySize = {
  cols: number;
  rows: number;
};

export class DockerCompose {
  private readonly livePtys = new Set<{ resize: (cols: number, rows: number) => void }>();
  private ptySize: PtySize = { cols: 120, rows: 30 };

  constructor(
    private readonly configPath: string,
    private readonly getSettings: () => ComposeSettings,
    private readonly onData: (data: string) => void,
  ) {}

  resize(size: PtySize) {
    if (!size?.cols || !size?.rows) return;
    if (size.cols === this.ptySize.cols && size.rows === this.ptySize.rows) return;
    this.ptySize = { cols: size.cols, rows: size.rows };
    for (const pty of this.livePtys) {
      try {
        pty.resize(this.ptySize.cols, this.ptySize.rows);
      } catch (err) {
        console.log('Failed to resize pty: ' + err);
      }
    }
  }

  run(command: string) {
    const emitter = new EventEmitter();
    const settings = this.getSettings();
    try {
      const pty = ptySpawn('docker', [
        'compose',
        '-f', this.configPath,
        ...settings.cfToken ? ['--profile', 'cf'] : [],
        ...settings.ngrokToken ? ['--profile', 'ngrok'] : [],
        command,
      ], {
        name: 'xterm-color',
        cols: this.ptySize.cols,
        rows: this.ptySize.rows,
        env: { ...process.env, COMPOSE_MENU: 'false' } as { [key: string]: string },
      });
      this.livePtys.add(pty);
      pty.onData(this.onData);
      pty.onExit(({ exitCode, signal }) => {
        this.livePtys.delete(pty);
        emitter.emit('exit', exitCode, signal ?? null);
        emitter.emit('close', exitCode, signal ?? null);
      });
    } catch (err) {
      setImmediate(() => emitter.emit('error', err));
    }
    return emitter;
  }
}
