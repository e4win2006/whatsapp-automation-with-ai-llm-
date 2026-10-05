import { db } from '../server/database/database';

function inspectDb() {
  console.log('=== SETTINGS ===');
  console.log(db.getAllSettings());

  console.log('\n=== CONTACTS ===');
  const contacts = db.getAllContacts();
  for (const c of contacts) {
    console.log(JSON.stringify(c, null, 2));
  }

  console.log('\n=== CONVERSATIONS ===');
  const convs = db.getAllConversations();
  for (const cv of convs) {
    console.log(JSON.stringify(cv, null, 2));
  }

  console.log('\n=== RECENT MESSAGES ===');
  const msgs = (db as any).db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 20').all();
  for (const m of msgs) {
    console.log(JSON.stringify(m, null, 2));
  }
}

inspectDb();
