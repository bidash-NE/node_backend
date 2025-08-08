const pool = require("../config/db");

const insertDriverDocuments = async (driver_id, documents) => {
  const values = documents.map((doc) => [
    driver_id,
    doc.document_type,
    doc.document_url,
  ]);
  const placeholders = values.map(() => "(?, ?, ?)").join(", ");

  const flatValues = values.flat();
  await pool.query(
    `INSERT INTO driver_documents (driver_id, document_type, document_url) VALUES ${placeholders}`,
    flatValues
  );
};

module.exports = { insertDriverDocuments };
