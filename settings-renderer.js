const settingElements = () => document.querySelectorAll('[data-setting]');
const profileElements = () => document.querySelectorAll('[data-profile]');

function updateSettings(settings) {
  if (settings.serverProfiles) {
    const activeProfiles = settings.serverProfiles.replace(/\s+/g, '').split(',');
    for (const input of profileElements()) {
      input.checked = activeProfiles.includes(input.dataset.profile);
    }
  }

  for (const input of settingElements()) {
    const value = settings[input.id];
    if (input.type === 'checkbox') {
      input.checked = value ?? false;
    } else {
      input.value = value ?? '';
    }
  }
}

function updateImageTags(imageTags) {
  for (const [key, tags] of Object.entries(imageTags)) {
    if (!Array.isArray(tags) || tags.length === 0) continue;

    const select = document.getElementById(key);
    const version = document.getElementById(`${key}Version`);
    if (!(select instanceof HTMLSelectElement) || !version) continue;

    select.replaceChildren(new Option('latest', 'latest'));
    for (const tag of [...tags].reverse()) {
      select.append(new Option(String(tag), String(tag)));
    }
    select.value = version.value;
  }
}

function saveSettings() {
  const settings = {};
  for (const input of settingElements()) {
    settings[input.id] = input.type === 'checkbox' ? input.checked : input.value;
  }
  window.electronAPI.saveSettings(settings);
  window.close();
}

function updateProfiles() {
  const activeProfiles = ['prod', 'storage', 'jwt'];
  for (const input of profileElements()) {
    if (input.checked) activeProfiles.push(input.dataset.profile);
  }
  document.getElementById('serverProfiles').value = activeProfiles.join(',');
}

function setCommandPending(id, pending) {
  document.getElementById(`${id}-button`).style.display = pending ? 'none' : 'block';
  document.getElementById(`${id}-loading`).style.display = pending ? 'block' : 'none';
}

function initialize() {
  window.electronAPI.handleSettings((_event, settings) => updateSettings(settings));
  window.electronAPI.notifyFinished((_event, command) => setCommandPending(command, false));
  window.electronAPI.updateImageTags((_event, imageTags) => updateImageTags(imageTags));

  document.getElementById('save-settings').addEventListener('click', saveSettings);

  for (const input of document.querySelectorAll('[data-patch]')) {
    input.addEventListener('change', () => {
      window.electronAPI.patchSettings({name: input.id, value: input.checked});
    });
  }

  for (const input of profileElements()) {
    input.addEventListener('change', updateProfiles);
  }

  for (const select of document.querySelectorAll('[data-version-target]')) {
    select.addEventListener('change', () => {
      document.getElementById(select.dataset.versionTarget).value = select.value;
    });
  }

  for (const button of document.querySelectorAll('[data-open-dir]')) {
    button.addEventListener('click', () => {
      window.electronAPI.openDir(document.getElementById(button.dataset.openDir).value);
    });
  }

  for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('click', () => {
      const command = button.dataset.command;
      window.electronAPI.command(command, []);
      setCommandPending(command, true);
    });
  }

  for (const input of document.querySelectorAll('input')) {
    input.addEventListener('focus', () => input.style.zIndex = '1');
    input.addEventListener('blur', () => input.style.zIndex = '');
  }

  window.electronAPI.fetchSettings();
}

window.addEventListener('DOMContentLoaded', initialize);
