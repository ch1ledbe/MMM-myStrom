# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

