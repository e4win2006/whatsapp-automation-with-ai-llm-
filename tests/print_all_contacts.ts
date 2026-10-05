import { db } from '../server/database/database';

function printAllContacts() {
  const contacts = (db as any).db.prepare('SELECT * FROM contacts').all();
  console.log(`Total DB Contacts: ${contacts.length}`);
  console.log(contacts);
}

printAllContacts();
