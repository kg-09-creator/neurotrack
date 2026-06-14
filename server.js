const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'history.json');

// Get exact local date string (YYYY-MM-DD)
function getLocalDateString() {
    const date = new Date();
    const offset = date.getTimezoneOffset();
    const localDate = new Date(date.getTime() - (offset * 60 * 1000));
    return localDate.toISOString().substring(0, 10);
}

function readHistory() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const initialHistory = {};
            const todayStr = getLocalDateString();
            initialHistory[todayStr] = { sleep_hours: 7.2, steps: 8400, calories: 500, hrv: 65 };
            fs.writeFileSync(DATA_FILE, JSON.stringify(initialHistory, null, 2));
            return initialHistory;
        }
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function writeHistory(history) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(history, null, 2));
}

function buildDashboardState() {
    const history = readHistory();
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

app.get('/api/status', (req, res) => {
    res.json(buildDashboardState());
});

app.post('/api/manual-log', (req, res) => {
    const { sleep, steps, hrv } = req.body;
    const history = readHistory();
    const todayStr = getLocalDateString();

    if (!history[todayStr]) {
        history[todayStr] = { sleep_hours: 7.2, steps: 8400, calories: 500, hrv: 65 };
    }

    if (sleep !== undefined) history[todayStr].sleep_hours = parseFloat(sleep);
    if (steps !== undefined) history[todayStr].steps = parseInt(steps);
    if (hrv !== undefined) history[todayStr].hrv = parseInt(hrv);

    writeHistory(history);
    res.json({ success: true });
});

// FIXED: Cleaned route naming context and fixed Apple Health XML identifier tokens
app.post('/api/upload-xml', upload.single('appleHealthFile'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file received." });

        const xmlData = fs.readFileSync(req.file.path, 'utf8');
        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
        const jsonObj = parser.parse(xmlData);

        let rawRecords = jsonObj.HealthData?.Record || [];
        if (!Array.isArray(rawRecords)) rawRecords = [rawRecords];

        const history = readHistory();
        const todayStr = getLocalDateString(); 

        rawRecords.forEach(rec => {
            if (!rec.startDate) return;
            
            // Extract the simple date prefix safely
            const dateStr = rec.startDate.substring(0, 10);

            // Skip today's data to protect live tracking overrides
            if (dateStr === todayStr) return;

            if (!history[dateStr]) {
                history[dateStr] = { sleep_hours: 0, steps: 0, calories: 0, hrv: 65 };
            }

            // FIXED: Corrected type identifier to accurately target Apple Health sleep tokens
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

            // Fallback default metric checks
            if (!history[dateStr].hrv) history[dateStr].hrv = 65;
        });

        writeHistory(history);
        try { fs.unlinkSync(req.file.path); } catch(e){}
        res.json({ success: true });
    } catch (err) {
        try { fs.unlinkSync(req.file.path); } catch(e){}
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/simulate-burnout', (req, res) => {
    const history = readHistory();
    const todayStr = getLocalDateString();
    
    history[todayStr] = { sleep_hours: 4.5, steps: 1900, calories: 150, hrv: 20 };
    writeHistory(history);
    res.json({ success: true });
});

app.post('/api/reset', (req, res) => {
    if (fs.existsSync(DATA_FILE)) {
        try { fs.unlinkSync(DATA_FILE); } catch(e){}
    }
    res.json({ success: true });
});

app.get('/api/history-timeline', (req, res) => {
    const history = readHistory();
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
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`Engine processing online at port ${PORT}`));