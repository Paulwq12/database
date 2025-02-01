require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
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

// Routes
app.get('/', (req, res) => {
    res.render('connect', { error: null, connectionString: '' });
});

app.post('/connect', async (req, res) => {
    const connectionString = req.body.connectionString;
    
    try {
        const pool = new Pool({ connectionString });
        const tables = await getTables(pool);
        await pool.end();
        
        res.render('dashboard', {
            connectionString,
            tables,
            backups: await getBackups(),
            indexes: [],
            history: [],
            error: null
        });
    } catch (err) {
        res.render('connect', { 
            error: `Connection failed: ${err.message}`,
            connectionString
        });
    }
});

app.post('/query', async (req, res) => {
    const { connectionString, query } = req.body;
    
    try {
        const pool = new Pool({ connectionString });
        const result = await pool.query(query);
        const tables = await getTables(pool);
        
        res.render('dashboard', {
            connectionString,
            tables,
            backups: await getBackups(),
            indexes: await getIndexes(pool),
            history: [{
                query,
                timestamp: new Date(),
                rows: result.rowCount
            }],
            results: result.rows,
            rowCount: result.rowCount,
            error: null
        });
        
        await pool.end();
    } catch (err) {
        res.render('dashboard', {
            connectionString,
            tables: [],
            backups: [],
            indexes: [],
            history: [],
            error: `Query error: ${err.message}`
        });
    }
});

app.get('/export/:table/:format', async (req, res) => {
    const connectionString = req.query.connectionString;
    
    try {
        const pool = new Pool({ connectionString });
        const { rows } = await pool.query(`SELECT * FROM ${req.params.table}`);
        
        if (req.params.format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=${req.params.table}.csv`);
            csv.write(rows, { headers: true }).pipe(res);
        } else {
            res.json(rows);
        }
        
        await pool.end();
    } catch (err) {
        res.status(500).send(err.message);
    }
});

const upload = multer({ dest: 'uploads/' });
app.post('/import/:table', upload.single('file'), async (req, res) => {
    const connectionString = req.body.connectionString;
    
    try {
        const pool = new Pool({ connectionString });
        const rows = [];
        
        fs.createReadStream(req.file.path)
            .pipe(csv.parse({ headers: true }))
            .on('data', row => rows.push(row))
            .on('end', async () => {
                const columns = Object.keys(rows[0]);
                const query = {
                    text: `INSERT INTO ${req.params.table} (${columns.join(',')}) VALUES ${rows.map((_, i) => `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(',')})`).join(',')}`,
                    values: rows.flatMap(Object.values)
                };
                
                await pool.query(query);
                res.redirect(`/?connectionString=${encodeURIComponent(connectionString)}`);
            });
    } catch (err) {
        res.render('dashboard', {
            connectionString,
            tables: [],
            backups: [],
            indexes: [],
            history: [],
            error: `Import error: ${err.message}`
        });
    }
});

app.post('/backup', async (req, res) => {
    const connectionString = req.body.connectionString;
    const timestamp = moment().format('YYYYMMDD-HHmmss');
    const filename = `backup-${timestamp}.sql`;
    
    exec(`pg_dump ${connectionString} > backups/${filename}`, (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect(`/?connectionString=${encodeURIComponent(connectionString)}`);
    });
});

app.post('/restore', upload.single('backup'), (req, res) => {
    const connectionString = req.body.connectionString;
    
    exec(`psql ${connectionString} -f ${req.file.path}`, (err) => {
        if (err) return res.status(500).send(err.message);
        res.redirect(`/?connectionString=${encodeURIComponent(connectionString)}`);
    });
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

function getBackups() {
    return new Promise((resolve) => {
        fs.readdir('backups', (err, files) => {
            resolve(err ? [] : files);
        });
    });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
