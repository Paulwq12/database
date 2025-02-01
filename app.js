require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bodyParser = require('body-parser');
const multer = require('multer');
const csv = require('fast-csv');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const moment = require('moment');
const _ = require('lodash');
const app = express();

// Configuration
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Session configuration using PostgreSQL
const sessionPool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(session({
  store: new pgSession({
    pool: sessionPool,
    tableName: 'user_sessions'
  }),
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 1 week
  }
}));

// Database middleware
app.use((req, res, next) => {
  if (req.session.dbConfig) {
    req.pool = new Pool({
      connectionString: req.session.dbConfig.connectionString
    });
  }
  next();
});

// Routes
app.get('/', (req, res) => {
  if (req.session.dbConfig) {
    return res.redirect('/dashboard');
  }
  res.render('connect', { error: null, connectionString: '' });
});

app.post('/connect', async (req, res) => {
  const connectionString = req.body.connectionString;
  
  try {
    // Validate connection
    const testPool = new Pool({ connectionString });
    await testPool.query('SELECT NOW()');
    await testPool.end();

    // Store connection in session
    req.session.dbConfig = { connectionString };
    req.session.save(() => res.redirect('/dashboard'));
    
  } catch (err) {
    res.render('connect', { 
      error: `Connection failed: ${err.message}`,
      connectionString: req.body.connectionString
    });
  }
});

app.get('/dashboard', async (req, res) => {
  if (!req.session.dbConfig) {
    return res.redirect('/');
  }

  try {
    const [tables, backups, indexes] = await Promise.all([
      getTables(req.pool),
      getBackups(),
      getIndexes(req.pool)
    ]);

    res.render('dashboard', {
      tables,
      backups,
      indexes,
      connectionInfo: req.session.dbConfig.connectionString,
      history: req.session.queryHistory || [],
      error: null
    });

  } catch (err) {
    res.render('connect', {
      error: `Connection error: ${err.message}`,
      connectionString: req.session.dbConfig?.connectionString || ''
    });
  }
});

// Query execution
app.post('/query', async (req, res) => {
  if (!req.pool) return res.redirect('/');

  try {
    const result = await req.pool.query(req.body.query);
    req.session.queryHistory = [{
      query: req.body.query,
      timestamp: new Date(),
      rows: result.rowCount
    }, ...(req.session.queryHistory || []).slice(0, 9)];

    res.render('results', {
      results: result.rows,
      rowCount: result.rowCount,
      query: req.body.query
    });
  } catch (err) {
    res.render('dashboard', {
      error: `Query error: ${err.message}`,
      ...(await getDashboardData(req))
    });
  }
});

// Export/Import
app.get('/export/:table/:format', async (req, res) => {
  if (!req.pool) return res.redirect('/');

  try {
    const { rows } = await req.pool.query(`SELECT * FROM ${req.params.table}`);
    
    if (req.params.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${req.params.table}.csv`);
      csv.write(rows, { headers: true }).pipe(res);
    } else {
      res.json(rows);
    }
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const upload = multer({ dest: 'uploads/' });
app.post('/import/:table', upload.single('file'), async (req, res) => {
  if (!req.pool) return res.redirect('/');

  try {
    const rows = [];
    fs.createReadStream(req.file.path)
      .pipe(csv.parse({ headers: true }))
      .on('data', row => rows.push(row))
      .on('end', async () => {
        const columns = Object.keys(rows[0]);
        const values = rows.map(row => columns.map(col => row[col]));
        const query = {
          text: `INSERT INTO ${req.params.table} (${columns.join(',')}) VALUES ${values.map((_, i) => `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(',')})`).join(',')}`,
          values: values.flat()
        };
        await req.pool.query(query);
        res.redirect('/dashboard');
      });
  } catch (err) {
    res.render('dashboard', {
      error: `Import error: ${err.message}`,
      ...(await getDashboardData(req))
    });
  }
});

// Backup/Restore
app.post('/backup', async (req, res) => {
  if (!req.session.dbConfig) return res.redirect('/');

  try {
    const timestamp = moment().format('YYYYMMDD-HHmmss');
    const filename = `backup-${timestamp}.sql`;
    const conn = req.session.dbConfig.connectionString;
    
    exec(`pg_dump ${conn} > backups/${filename}`, (err) => {
      if (err) throw err;
      res.redirect('/dashboard');
    });
  } catch (err) {
    res.render('dashboard', {
      error: `Backup error: ${err.message}`,
      ...(await getDashboardData(req))
    });
  }
});

app.post('/restore', upload.single('backup'), async (req, res) => {
  if (!req.session.dbConfig) return res.redirect('/');

  try {
    const conn = req.session.dbConfig.connectionString;
    exec(`psql ${conn} -f ${req.file.path}`, (err) => {
      if (err) throw err;
      res.redirect('/dashboard');
    });
  } catch (err) {
    res.render('dashboard', {
      error: `Restore error: ${err.message}`,
      ...(await getDashboardData(req))
    });
  }
});

// Index management
app.post('/index', async (req, res) => {
  if (!req.pool) return res.redirect('/');

  try {
    const query = {
      text: `CREATE INDEX $1 ON $2 USING $3 ($4)`,
      values: [req.body.name, req.body.table, req.body.type, req.body.columns]
    };
    await req.pool.query(query);
    res.redirect('/dashboard');
  } catch (err) {
    res.render('dashboard', {
      error: `Index error: ${err.message}`,
      ...(await getDashboardData(req))
    });
  }
});

// Helpers
async function getTables(pool) {
  const { rows } = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
  `);
  return rows;
}

async function getIndexes(pool) {
  const { rows } = await pool.query(`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE schemaname = 'public'
  `);
  return rows;
}

async function getDashboardData(req) {
  return {
    tables: await getTables(req.pool),
    backups: await getBackups(),
    indexes: await getIndexes(req.pool),
    connectionInfo: req.session.dbConfig.connectionString,
    history: req.session.queryHistory || []
  };
}

function getBackups() {
  return new Promise((resolve) => {
    fs.readdir('backups', (err, files) => {
      resolve(err ? [] : files);
    });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
