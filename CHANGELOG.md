# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0 - 2026-11-01
### security
- updated nodemailer to 10.3.1 (fixes several known vulnerabilities of 7.x), axios to >= 1.12.2
- SMTP user/password can be kept in `secrets.json` or the environment variables `MYSTROM_SMTP_USER` / `MYSTROM_SMTP_PASS` instead of `config.js`, which is visible to every browser
- node_helper accepts the configuration only once, validates device addresses and limits device responses (64 KB, no redirects)
- email alerts are only sent for configured devices and known alert types, with a cooldown per device and alert type (`emailAlert.cooldownMs`)
- `npm run upgrade` no longer runs `git reset --hard` / `git clean -fd` and keeps own sound files

### fixed
- polling no longer starts new requests while the previous ones are still running
- per-type update intervals (`PIRUpdateInterval`, `SwitchUpdateInterval`, `BulbUpdateInterval`) are respected
- email subject of the "switched on" alert
- `defaultEmailAlert` is now a real option (default `false`)
- global off sounds are read from `alertFilesOff` as used in the code; the old README name `alertFileOff` still works
- per-device sounds per alert type (`alertFile`, `alertFileOff`, `alertFilePower`, `alertFilePowerNormal`, `alertFilePirClear`); `alertFile` no longer replaces the power sounds
- no alerts from the first reading after start or browser reload
- HTTP errors are translated and show the status code
- removed unused dependency `node-fetch` and dead code in node_helper
- package-lock.json now matches package.json, lint tooling added (`npm run lint`), contradicting quote rules in eslint.config.mjs fixed
- removed an invalid `border-left` rule in mystrom.css (browsers ignored it, the look is unchanged)

## 1.1.3 - 2026-01-06
### fixed
- removed vulnerable package nodemailer-smtp-transport - Nodemailer native SMTP is being used now
- adjusted node_helper.js accordingly

## 1.1.2 - 2026-01-06
### fixed
- corrected the nodemailer version in package.json
- imporved the README.md file

## 1.1.1 - 2025-12-07
### fixed
- nodemailer config to 7.0.11
- improved "npm run upgrade"

## 1.1.0 - 2025-12-07
### Added
- Alert system:
    - On → Off
    - Off → On
    - Power above threshold
    - Power normalized
    - PIR motion cleared
    - Custom alert sounds (per device or per type)
    - Email notifications using SMTP
- Implemented "npm run upgrade" 

## 1.0.0 - 2025-11-26
### Added
- Initial release
- Multiple device types (PIR, Switch, Bulb)
- Automatic polling & UI refresh
- Multi-room display (Column, inline, side-by-side, room badges)
- Color visualization for bulbs
- Multi-language localized UI
- Error & loading handling
- Legacy config compatibility

