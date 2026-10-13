'use strict';
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const WB_DIR = path.join(CLAUDE_DIR, 'workbench');

module.exports = {
  HOME,
  CLAUDE_DIR,
  WB_DIR,
  PROJECTS_DIR: path.join(CLAUDE_DIR, 'projects'),
  INDEX_FILE: path.join(WB_DIR, 'data', 'index.json'),
  ITEMS_FILE: path.join(WB_DIR, 'data', 'items.json'),
  BACKUP_DIR: path.join(WB_DIR, 'data', 'backups'),
  DEV_ROOT: path.join(HOME, 'dev'),
};
