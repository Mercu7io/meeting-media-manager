# Update Tracking

- Project initialized tracking for HTTP/WebSocket remote control server and mobile PWA controller.
- Implemented embedded HTTP/WebSocket server in `src-electron/remote/` with token authentication, command dispatching, state broadcasting, and static PWA assets.
- Added strictly typed IPC bridges and preload bindings connecting Electron Main and Renderer for remote control communication.
- Implemented state synchronization, action dispatchers, and PIN generators in `src/helpers/remote-control.ts` with Pinia store integration.
- Added `RemoteControlButton` and `DialogRemoteControlPopup` to the Action Island with quick-pairing QR code display and LAN URLs.
- Created responsive dark-mode mobile web controller PWA with real-time playback monitoring, transport bar, seek slider, and queue selection.
- Added unit tests for remote control server and renderer helper with complete test coverage.
- Updated README.md with remote control server and mobile PWA feature highlights.
- Added prominent fork announcement banner in README.md highlighting origin repository and wireless remote control additions.
- Filtered non-routable link-local IPs, prioritized true LAN addresses, and added in-app local browser testing button and QR IP selector.
- Embedded static PWA assets directly into server bundle to prevent 404 Not Found in packaged builds and added openExternalUrl IPC bridge to fix the browser launch button.
- Enhanced mobile remote control with direct stop execution, optimistic play/pause transitions, playlist refresh button, song number badges, and collapsible meeting folder groups.
- Fixed playback state resolution in formatRemoteControlState to correctly recognize active media when mediaPlaying.action is empty, allowing the play button to properly toggle to pause.
- Added divider item display and foldable meeting sections with item count badges to the remote control web view.
