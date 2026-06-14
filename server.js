const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
// FIXED: Imported Vercel KV storage client to handle persistent database sync
const { kv } = require('@vercel/kv'); 
const app = express();

// FIXED: Use memory storage instead of disk storage to prevent Vercel EROFS read-only crashes
const upload = multer({ storage: multer.memoryStorage() });

// --- VERCEL ROUTING PATCHES ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ------------------------------

// Fixed Key constant for Redis lookups
const KV_HISTORY_KEY = 'neurotrack_user_history';

// Get exact local date string (YYYY-MM-DD)
function getLocalDateString() {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    const localDate = new Date(date.getTime() - (offset * 60 * 1000));
    return localDate.toISOString().substring(0, 10);
}

// FIXED: Converted to async database retrieval to pull records persistently from Vercel KV
async function readHistory() {
    try {
        const data = await kv.get(KV_HISTORY_KEY);
        if (!data) {
            // Seed baseline data if database is totally empty
            const initialHistory = {};
            const todayStr = getLocalDateString();
            initialHistory[todayStr] = { sleep_hours: 7.2, steps: 8400, calories: 500, hrv: 65 };
            await kv.set(KV_HISTORY_KEY, initialHistory);
            return initialHistory;
        }
        return data;
    } catch (e) {
        console.error("Database read fault:", e);
        return {};
    }
}

// FIXED: Converted to async database persistence writes
async function writeHistory(history) {
    try {
        await kv.set(KV_HISTORY_KEY, history);
    } catch (e) {
        console.error("Database write fault:", e);
    }
}

function calculateDashboardMetrics(history) {
    const todayStr = getLocalDateString();
    const todayData = history[todayStr] || { sleep_hours: 7.2, steps: 8400, calories: 500, hrv: 65 };
    const allDates = Object.keys(history).sort();
    
    const historicalDates = allDates.filter(d => {
        return d !== todayStr && history[d] && history[d].steps > 500 && history[d].sleep_hours > 2;
    }).slice(-14);

    const avgSteps = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (history[d].steps || 0), 0) / historicalDates.length) : 8000;
    const avgCalories = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (history[d].calories || 0), 0) / historicalDates.length) : 600;
    const avgSleep = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (history[d].sleep_hours || 0), 0) / historicalDates.length) : 7.5;
    const avgHRV = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (history[d].hrv || 0), 0) / historicalDates.length) : 65;

    const triggers = [];
    let riskScore = 0;

    if (todayData.sleep_hours < avgSleep * 0.85) {
        triggers.push(`Rest Deficit: Only logged ${todayData.sleep_hours}h of sleep (Baseline: ${avgSleep.toFixed(1)}h).`);
        riskScore += 35;
    }
    if (todayData.steps < avgSteps * 0.7) {
        triggers.push(`Physical Deficit: Steps dropped down to ${todayData.steps.toLocaleString()} (Baseline: ${Math.round(avgSteps).toLocaleString()}).`);
        riskScore += 35;
    }
    if (todayData.hrv < avgHRV * 0.75) {
        triggers.push(`Autonomic Strain: HRV dropped down to ${todayData.hrv} ms (Baseline: ${Math.round(avgHRV)} ms).`);
        riskScore += 30;
    }

    riskScore = Math.min(riskScore, 100);
    let systemState = "Stable & Balanced";
    if (riskScore >= 70) systemState = "Critical Burnout";
    else if (riskScore > 0) systemState = "Caution";

    return {
        systemState,
        riskScore,
        today: {
            sleep_hours: parseFloat(parseFloat(todayData.sleep_hours).toFixed(1)),
            steps: Math.round(todayData.steps),
            calories: Math.round(todayData.calories),
            hrv: Math.round(todayData.hrv || 65)
        },
        baselines: {
            sleepMean: parseFloat(avgSleep.toFixed(1)),
            stepsMean: Math.round(avgSteps),
            caloriesMean: Math.round(avgCalories),
            hrvMean: Math.round(avgHRV)
        },
        triggers: triggers.length ? triggers : ["All parameters look healthy and within your normal range."]
    };
}

// FIXED: Updated status route wrapper to handle async database compilation
app.get('/api/status', async (req, res) => {
    try {
        const history = await readHistory();
        res.json(calculateDashboardMetrics(history));
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/manual-log', async (req, res) => {
    try {
        // ADDED: The server now accepts a 'date' field sent directly from your shortcut
        const { sleep, steps, hrv, date } = req.body; 
        const history = await readHistory();
        
        // Use the date from the shortcut if it exists; otherwise, fallback to local server date
        const targetDate = date || getLocalDateString();

        if (!history[targetDate]) {
            history[targetDate] = { sleep_hours: 7.2, steps: 8400, calories: 500, hrv: 65 };
        }

        if (sleep !== undefined) history[targetDate].sleep_hours = parseFloat(sleep);
        if (steps !== undefined) history[targetDate].steps = parseInt(steps);
        if (hrv !== undefined) history[targetDate].hrv = parseInt(hrv);

        await writeHistory(history);
        res.json({ success: true, loggedForDate: targetDate });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// FIXED: Updated Shortcut payload parser with async writing hooks to stop data drops 
app.post(['/api/upload-xml', '/api/upload-csv'], upload.any(), async (req, res) => {
    try {
        const targetedFile = req.file || (req.files && req.files.find(f => f.fieldname === 'csvFile')) || (req.files && req.files[0]);
        if (!targetedFile) return res.status(400).json({ success: false, error: "No file received." });

        const xmlData = targetedFile.buffer.toString('utf8');
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
        const jsonObj = parser.parse(xmlData);

        let rawRecords = jsonObj.HealthData?.Record || [];
        if (!Array.isArray(rawRecords)) rawRecords = [rawRecords];

        const history = await readHistory();
        const todayStr = getLocalDateString(); 

        rawRecords.forEach(rec => {
            if (!rec.startDate) return;
            
            const dateStr = rec.startDate.substring(0, 10);
            if (dateStr === todayStr) return;

            if (!history[dateStr]) {
                history[dateStr] = { sleep_hours: 0, steps: 0, calories: 0, hrv: 65 };
            }

            if (rec.type === "HKCategoryTypeIdentifierSleepAnalysis" || rec.value === "HKCategoryValueSleepAnalysisAsleep") {
                const start = new Date(rec.startDate);
                const end = new Date(rec.endDate || rec.startDate);
                const durationHrs = (end - start) / (1000 * 60 * 60);
                if (durationHrs > 0 && durationHrs < 24) {
                    history[dateStr].sleep_hours += durationHrs;
                }
            }
            
            if (rec.type === "HKQuantityTypeIdentifierStepCount") {
                history[dateStr].steps += parseInt(rec.value || 0);
            }
            
            if (rec.type === "HKQuantityTypeIdentifierActiveEnergyBurned") {
                history[dateStr].calories += parseFloat(rec.value || 0);
            }

            if (!history[dateStr].hrv) history[dateStr].hrv = 65;
        });

        await writeHistory(history);
        res.json({ success: true, message: "Shortcut data written permanently to cloud DB." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// FIXED: Async transition complete
app.post('/api/simulate-burnout', async (req, res) => {
    try {
        const history = await readHistory();
        const todayStr = getLocalDateString();
        
        history[todayStr] = { sleep_hours: 4.5, steps: 1900, calories: 150, hrv: 20 };
        await writeHistory(history);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// FIXED: Drops the persistence hash entirely upon user instantiation requests
app.post('/api/reset', async (req, res) => {
    try {
        await kv.del(KV_HISTORY_KEY);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// FIXED: Timeline graph calculations dynamically fetch data from the cloud
app.get('/api/history-timeline', async (req, res) => {
    try {
        const history = await readHistory();
        const allDates = Object.keys(history).sort();
        
        const sortedDates = allDates.filter(d => history[d] && (history[d].steps > 500 || history[d].sleep_hours > 2)).slice(-14);

        const labels = [];
        const sleepDataset = [];
        const stepsDataset = [];
        const hrvDataset = [];

        sortedDates.forEach(date => {
            const dateObj = new Date(date + 'T00:00:00');
            const formattedLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
            
            labels.push(formattedLabel);
            sleepDataset.push(parseFloat((history[date].sleep_hours || 0).toFixed(1)));
            stepsDataset.push(Math.round(history[date].steps || 0));
            hrvDataset.push(Math.round(history[date].hrv || 65));
        });

        res.json({
            labels: labels,
            sleep: sleepDataset,
            steps: stepsDataset,
            hrv: hrvDataset
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine processing online at port ${PORT}`));
