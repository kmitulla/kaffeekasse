# Sicherheitstests für die Firestore-Regeln

Spielt ~35 konkrete Angriffe (z. B. negative Beträge, Rechteausweitung,
Schadcode in Feldern, gefälschter Master) und ~30 legitime App-Abläufe gegen
`../../firestore.rules` im offiziellen Firebase-Emulator durch. Erwartet:
**alle Angriffe blockiert, alle Abläufe erlaubt.** Läuft komplett lokal –
die echte Datenbank wird nie berührt. Benötigt Node.js und Java.

```bash
cd tools/security-tests
npm install --ignore-scripts
npm test
```
