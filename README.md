# Jasper Desktop App
Desktop app for [Jasper KM](https://github.com/cjmalloy/jasper). Uses electron to wrap a docker compose config.  
[Downloads](https://github.com/cjmalloy/jasper-app/releases/latest)

## Prerequisites
Docker Compose is required. Install from https://www.docker.com/products/docker-desktop/

## Troubleshooting
If the docker daemon is not running the app will not start.

## Developing
This project uses npm and typescript. Run `npm install` to install dependencies.

### Development application

Run `npm start` to compile and start electron. Editing `app.ts` will require restarting, but you can edit any of the html views,
`loading.html`, `logs.html`, `settings.html` and reload the electron window.

### Build

Run `npm run build` to build the project. The build artifacts will be stored in the `release/` directory.

### Debugging Jasper-UI

Right click on any electron window and click Inspect to open the debugger.
