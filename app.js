require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
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
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

app.set('view engine', 'ejs');

// Database middleware
app.use((req, res, next) => {
    if (req.session.dbConfig) {
        req.pool = new Pool({
            connectionString: req.session.dbConfig.connectionString
        });
    }
    next();
});

// In your app.js
app.get('/', (req, res) => {
    res.render('connect', { error: null }); // Explicitly pass error as null
});

app.post('/connect', async (req, res) => {
    const connectionString = req.body.connectionString;
    req.session.dbConfig = { connectionString };

    try {
        const pool = new Pool({ connectionString });
        await pool.query('SELECT NOW()');
        res.redirect('/dashboard');
    } catch (err) {
        res.render('connect', { error: err.message });
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.pool) return res.redirect('/');
    
    try {
        const tables = await getTables(req.pool);
        const history = req.session.queryHistory || [];
        const backups = await getBackups();
        const indexes = await getIndexes(req.pool);
        
        res.render('index', {
            tables,
            history,
            backups,
            indexes,
            currentTable: null,
            results: null,
            error: null
        });
    } catch (err) {
        res.render('index', { error: err.message });
    }
});

// Query execution
app.post('/query', async (req, res) => {
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
        res.render('error', { error: err.message });
    }
});

// Export/Import
app.get('/export/:table/:format', async (req, res) => {
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
    try {
        const rows = [];
        fs.createReadStream(req.file.path)
            .pipe(csv.parse({ headers: true }))
            .on('data', row => rows.push(row))
            .on('end', async () => {
                const columns = Object.keys(rows[0]);
                const values = rows.map(row => columns.map(col => row[col]));
                const query = `INSERT INTO ${req.params.table} (${columns.join(',')}) VALUES ${values.map(v => `(${v.map(x => `'${x}'`).join(',')})`).join(',')}`;
                await req.pool.query(query);
                res.redirect('/dashboard');
            });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Backup/Restore
app.post('/backup', async (req, res) => {
    const timestamp = moment().format('YYYYMMDD-HHmmss');
    const filename = `backup-${timestamp}.sql`;
    const conn = req.session.dbConfig.connectionString;
    
    exec(`pg_dump ${conn} > backups/${filename}`, (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/dashboard');
    });
});

app.post('/restore', upload.single('backup'), (req, res) => {
    const conn = req.session.dbConfig.connectionString;
    exec(`psql ${conn} -f ${req.file.path}`, (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect('/dashboard');
    });
});

// Index management
app.post('/index', async (req, res) => {
    try {
        const query = `CREATE INDEX ${req.body.name} ON ${req.body.table} USING ${req.body.type} (${req.body.columns})`;
        await req.pool.query(query);
        res.redirect('/dashboard');
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/indexes', async (req, res) => {
    try {
        const indexes = await getIndexes(req.pool);
        res.render('indexes', { indexes });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// Helper functions
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

function getBackups() {
    return new Promise((resolve) => {
        fs.readdir('backups', (err, files) => {
            resolve(err ? [] : files);
        });
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
