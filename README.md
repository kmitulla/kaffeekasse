# ☕️ Kaffeekasse

Eine Web-App zum fairen Teilen von Team-Ausgaben (Kaffeebohnen, Milch & Co.) –
ähnlich wie Splid, im iOS-Glass-Design. Läuft auf dem iPhone (als App auf dem
Homescreen) und am PC im Browser. Offline-fähig, Änderungen werden automatisch
synchronisiert.

**Live:** `https://kmitulla.github.io/kaffeekasse/`

---

## 🚀 Einmalige Einrichtung (Schritt für Schritt)

Du musst 4 Dinge machen – alles zusammen ca. 10 Minuten:

### 1. Firestore-Datenbank anlegen

1. Öffne die [Firebase Console](https://console.firebase.google.com/) und wähle dein Projekt **kaffeekasse-a06c7**.
2. Links im Menü: **Build → Firestore Database**.
3. Klicke **Datenbank erstellen** → Standort **europe-west3 (Frankfurt)** → Modus egal (wir ersetzen die Regeln gleich sowieso) → **Erstellen**.

### 2. Sicherheitsregeln einfügen (WICHTIG! 🔒)

Das schützt deine Daten. Der API-Key im Code ist übrigens **kein Geheimnis** –
er sagt nur, zu welchem Firebase-Projekt die App gehört. Was jemand damit darf,
bestimmen allein diese Regeln:

1. In der Firebase Console: **Firestore Database → Regeln** (Tab oben).
2. Lösche alles, was dort steht.
3. Öffne die Datei [`firestore.rules`](./firestore.rules) hier im Repository,
   kopiere den **kompletten Inhalt** und füge ihn dort ein.
4. Klicke **Veröffentlichen**.

### 3. Anmeldung (Auth) aktivieren

1. In der Firebase Console: **Build → Authentication → Jetzt starten**.
2. Tab **Sign-in method** → **E-Mail/Passwort** → aktivieren → **Speichern**.
3. Tab **Settings → Autorisierte Domains** → **Domain hinzufügen** →
   `kmitulla.github.io` eintragen.

### 4. GitHub Pages aktivieren

1. Auf GitHub im Repository: **Settings → Pages**.
2. Bei **Source**: „Deploy from a branch“ wählen.
3. Branch: **main**, Ordner: **/ (root)** → **Save**.
4. Nach 1–2 Minuten ist die App unter `https://kmitulla.github.io/kaffeekasse/` erreichbar.

### Optional, aber empfohlen: API-Key auf deine Domain beschränken

1. Öffne die [Google Cloud Console → Anmeldedaten](https://console.cloud.google.com/apis/credentials) (Projekt kaffeekasse-a06c7).
2. Klicke auf den **Browser key (auto created by Firebase)**.
3. Bei **Anwendungseinschränkungen**: „Websites“ wählen und hinzufügen:
   - `https://kmitulla.github.io/*`
   - `http://localhost:*` (zum Testen)
4. Speichern. Damit funktioniert der Key nur noch auf deiner Seite.

---

## 📱 Auf dem iPhone installieren

1. Öffne die App-Adresse in **Safari**.
2. Teilen-Symbol → **„Zum Home-Bildschirm“**.
3. Fertig – die App startet dann im Vollbild mit eigenem Icon.

## 👥 So benutzt ihr die App

1. **Registrieren** (Name, E-Mail, Passwort). Man bleibt angemeldet.
2. Der Erste erstellt ein **Team** – er ist automatisch **Benutzer** (Inhaber, alle Rechte).
3. Auf dem Tab **Team** steht der **Einladungscode** – den an die Kollegen schicken.
4. Kollegen registrieren sich und treten mit dem Code bei (Rolle: **User**).
5. Der Inhaber kann Mitglieder zum **Admin** machen (Tab Team → Mitglied antippen).

### Rollen

| Rolle | Rechte |
|---|---|
| **Benutzer** (Inhaber) | Alles: Team löschen, Rollen vergeben, plus alle Admin-Rechte |
| **Admin** | Mitglieder verwalten & entfernen (mit Verrechnung), Gruppen/Presets, alle Ausgaben bearbeiten |
| **User** | Eigene Ausgaben eintragen/ändern/löschen, Zahlungen melden & bestätigen |

### Ausgaben & Ausgleich

- **+** unten rechts: Ausgabe eintragen – was, wie viel, wann, wer hat gezahlt, wer ist beteiligt.
- Beteiligung wahlweise **gleichmäßig** oder mit **individuellen Prozenten** (z. B. 10 / 40 / 50).
- Admins können **Gruppen** anlegen (z. B. „Team Milch“) – dann reicht ein Tipp auf den Chip.
- Das **Dashboard** zeigt deinen Saldo, wem du was schuldest bzw. wer dir was schuldet, und die letzten 5 Ausgaben.
- **Ausgleich:** Der Schuldner tippt „Ich habe bezahlt“ → der Empfänger bestätigt, sobald das Geld da ist. Erst dann gilt es als ausgeglichen. Der Empfänger kann den Erhalt auch direkt selbst verbuchen.
- **Mitglied verlässt das Team:** Admin entfernt es; ein offener Restbetrag kann auf die anderen verteilt werden – auch prozentual unterschiedlich.
- **Neue Mitglieder** starten ab ihrem Beitrittsdatum und sind von älteren Ausgaben nicht betroffen.

### Offline

Die App funktioniert auch ohne Internet – der Status oben zeigt an:
**Online · synchron**, **Synchronisiert …**, **Offline** oder **Offline · Sync ausstehend**.
Sobald wieder Internet da ist, wird alles automatisch abgeglichen.

---

## 🛠 Technik

- Reines HTML/CSS/JavaScript – kein Build-Schritt, läuft direkt auf GitHub Pages
- Firebase Authentication (E-Mail/Passwort) & Cloud Firestore (mit Offline-Cache)
- PWA: Service Worker, Web-App-Manifest, App-Icon
- Beträge werden intern in Cent gerechnet (keine Rundungsfehler)
