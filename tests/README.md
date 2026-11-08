# Permission tests

Run the Firestore security-rule tests against the local emulator:

```bash
npm i -D firebase-tools @firebase/rules-unit-testing firebase
npx firebase emulators:exec --only firestore --project demo-quran "node --test tests/rules.test.mjs"
```
