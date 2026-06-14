const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { kv } = require('@vercel/kv'); 
const app = express();

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const KV_HISTORY_KEY = 'neurotrack_user_history';

function getLocalDateString() {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    const localDate = new Date(date.getTime() - (offset * 60 * 1000));
    return localDate.toISOString().substring(0, 10);
}

async function readHistory() {
    try {
        const data = await kv.get(KV_HISTORY_KEY);
        return data || {};
    } catch (e) {
        console.error("Database read fault:", e);
        return {};
    }
}

async function writeHistory(history) {
    try {
        await kv.set(KV_HISTORY_KEY, history);
    } catch (e) {
        console.error("Database write fault:", e);
    }
}

function calculateDashboardMetrics(history) {
    const todayStr = getLocalDateString();
    
    // Fallback defaults if absolutely nothing exists yet
    const todayData = history[todayStr] || { sleep_hours: 0, steps: 0, calories: 0, hrv: 65 };
    const allDates = Object.keys(history).sort();
    
    // FIXED: Loosened historical filters so logs aren't accidentally hidden from baseline maps
    const historicalDates = allDates.filter(d => {
        return history[d] && (history[d].steps >= 0 || history[d].sleep_hours >= 0);
    }).slice(-14);

    const avgSteps = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (Number(history[d].steps) || 0), 0) / historicalDates.length) : 8000;
    const avgCalories = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (Number(history[d].calories) || 0), 0) / historicalDates.length) : 600;
    const avgSleep = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (Number(history[d].sleep_hours) || 0), 0) / historicalDates.length) : 7.5;
    const avgHRV = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (Number(history[d].hrv) || 0), 0) / historicalDates.length) : 65;

    const triggers = [];
    let riskScore = 0;

    if (Number(todayData.sleep_hours) < avgSleep * 0.85 && Number(todayData.sleep_hours) > 0) {
        triggers.push(`Rest Deficit: Only logged ${todayData.sleep_hours}h of sleep (Baseline: ${avgSleep.toFixed(1)}h).`);
        riskScore += 35;
    }
    if (Number(todayData.steps) < avgSteps * 0.7 && Number(todayData.steps) > 0) {
        triggers.push(`Physical Deficit: Steps dropped down to ${Number(todayData.steps).toLocaleString()} (Baseline: ${Math.round(avgSteps).toLocaleString()}).`);
        riskScore += 35;
    }
    if (Number(todayData.hrv) < avgHRV * 0.75 && Number(todayData.hrv) > 0) {
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
            sleep_hours: parseFloat(parseFloat(todayData.sleep_hours || 0).toFixed(1)),
            steps: Math.round(todayData.steps || 0),
            calories: Math.round(todayData.calories || 0),
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

app.get('/api/status', async (req, res) => {
    try {
        const history = await readHistory();
        res.json(calculateDashboardMetrics(history));
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// FIXED: Sanitizes Shortcut payload data strings straight into actual Numbers
app.post('/api/manual-log', async (req, res) => {
    try {
        const { sleep, steps, hrv, date } = req.body;
        console.log("Incoming Payload Data From iOS:", req.body);

        const history = await readHistory();
        const targetDate = date || getLocalDateString();

        if (!history[targetDate]) {
            history[targetDate] = { sleep_hours: 0, steps: 0, calories: 0, hrv: 65 };
        }

        // Force convert incoming strings into functional numbers
        if (sleep !== undefined) history[targetDate].sleep_hours = parseFloat(sleep) || 0;
        if (steps !== undefined) history[targetDate].steps = parseInt(steps, 10) || 0;
        if (hrv !== undefined) history[targetDate].hrv = parseInt(hrv, 10) || 65;

        await writeHistory(history);
        res.json({ success: true, dateLogged: targetDate, currentStore: history[targetDate] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

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
                if (durationHrs > 0 && durationHrs < 24) history[dateStr].sleep_hours += durationHrs;
            }
            if (rec.type === "HKQuantityTypeIdentifierStepCount") history[dateStr].steps += parseInt(rec.value || 0, 10);
            if (rec.type === "HKQuantityTypeIdentifierActiveEnergyBurned") history[dateStr].calories += parseFloat(rec.value || 0);
        });

        await writeHistory(history);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/history-timeline', async (req, res) => {
    try {
        const history = await readHistory();
        const allDates = Object.keys(history).sort();
        
        // FIXED: Dropped rigid visual locks so any uploaded days render directly onto ChartJS
        const sortedDates = allDates.filter(d => history[d]).slice(-14);

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

        res.json({ labels, sleep: sleepDataset, steps: stepsDataset, hrv: hrvDataset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/reset', async (req, res) => {
    try {
        await kv.del(KV_HISTORY_KEY);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine online on port ${PORT}`));
