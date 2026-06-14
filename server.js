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
    
    // Configured exclusively for Steps and Calories
    const todayData = history[todayStr] || { steps: 0, calories: 0 };
    const allDates = Object.keys(history).sort();
    
    const historicalDates = allDates.filter(d => {
        return history[d] && (history[d].steps >= 0 || history[d].calories >= 0);
    }).slice(-14);

    const avgSteps = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (Number(history[d].steps) || 0), 0) / historicalDates.length) : 8000;
    const avgCalories = historicalDates.length ? (historicalDates.reduce((acc, d) => acc + (Number(history[d].calories) || 0), 0) / historicalDates.length) : 600;

    const triggers = [];
    let riskScore = 0;

    if (Number(todayData.steps) < avgSteps * 0.7 && Number(todayData.steps) > 0) {
        triggers.push(`Physical Deficit: Steps dropped down to ${Number(todayData.steps).toLocaleString()} (Baseline: ${Math.round(avgSteps).toLocaleString()}).`);
        riskScore += 50;
    }
    if (Number(todayData.calories) < avgCalories * 0.7 && Number(todayData.calories) > 0) {
        triggers.push(`Energy Burn Deficit: Output dropped down to ${Number(todayData.calories).toLocaleString()} kcal (Baseline: ${Math.round(avgCalories).toLocaleString()} kcal).`);
        riskScore += 50;
    }

    riskScore = Math.min(riskScore, 100);
    let systemState = "Stable & Balanced";
    if (riskScore >= 70) systemState = "Inactive State";
    else if (riskScore > 0) systemState = "Caution";

    return {
        systemState,
        riskScore,
        today: {
            steps: Math.round(todayData.steps || 0),
            calories: Math.round(todayData.calories || 0),
            sleep_hours: 0, // structural bypass
            hrv: 0          // structural bypass
        },
        baselines: {
            stepsMean: Math.round(avgSteps),
            caloriesMean: Math.round(avgCalories)
        },
        triggers: triggers.length ? triggers : ["Activity parameters look balanced for today."]
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

app.post('/api/manual-log', async (req, res) => {
    try {
        const { steps, calories, date } = req.body;
        console.log("Incoming Payload Data From iOS:", req.body);

        const history = await readHistory();
        const targetDate = date || getLocalDateString();

        if (!history[targetDate]) {
            history[targetDate] = { steps: 0, calories: 0 };
        }

        // Only parse steps and calories
        if (steps !== undefined) history[targetDate].steps = parseInt(steps, 10) || 0;
        if (calories !== undefined) history[targetDate].calories = parseInt(calories, 10) || 0;

        await writeHistory(history);
        res.json({ success: true, dateLogged: targetDate, currentStore: history[targetDate] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/history-timeline', async (req, res) => {
    try {
        const history = await readHistory();
        const allDates = Object.keys(history).sort();
        const sortedDates = allDates.filter(d => history[d]).slice(-14);

        const labels = [];
        const stepsDataset = [];
        const caloriesDataset = [];

        sortedDates.forEach(date => {
            const dateObj = new Date(date + 'T00:00:00');
            const formattedLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
            
            labels.push(formattedLabel);
            stepsDataset.push(Math.round(history[date].steps || 0));
            caloriesDataset.push(Math.round(history[date].calories || 0));
        });

        res.json({ labels, steps: stepsDataset, calories: caloriesDataset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Engine online on port ${PORT}`));
