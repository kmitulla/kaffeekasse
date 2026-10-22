# Firebase-SDK lokal bündeln

Die App lädt Firebase **nicht** von einem fremden Server (CDN), sondern aus
`js/vendor/firebase.js`. Vorteile: fest geprüfte Version, strenge
Content-Security-Policy möglich (nur eigener Code darf laufen), funktioniert
offline.

Neu bauen (nur bei einem Firebase-Update nötig):

```bash
cd tools/firebase-bundle
npm ci --ignore-scripts      # Install-Skripte aus: Schutz vor npm-Würmern
npm audit                    # muss "found 0 vulnerabilities" melden
npm run build
```

Versionen sind in `package.json` exakt festgelegt und über
`package-lock.json` mit Prüfsummen gesichert. Bei Updates nur Versionen
nehmen, die schon mindestens zwei Wochen veröffentlicht sind.
