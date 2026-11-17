const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


const getWeatherDesc = (code) => {
    if (code === 0) return "Clear sky";
    if (code >= 1 && code <= 3) return "Partly cloudy";
    if (code >= 45 && code <= 48) return "Fog";
    if (code >= 51 && code <= 67) return "Rain";
    if (code >= 71 && code <= 77) return "Snow";
    if (code >= 95) return "Thunderstorm";
    return "Unknown";
};

// Forecast Endpoint 
app.get('/api/v1/forecast', async (req, res) => {
    try {
        const { lat, lon } = req.query;
        
        const weatherRes = await axios.get(`https://api.open-meteo.com/v1/forecast`, {
            params: {
                latitude: lat,
                longitude: lon,
                current: 'temperature_2m,relative_humidity_2m,weather_code',
                hourly: 'temperature_2m',
                timezone: 'auto'
            }
        });

        const current = weatherRes.data.current;
        const hourly = weatherRes.data.hourly;

        // Format the next 5 hours for the forecast
        const forecast = [];
        for (let i = 0; i < 5; i++) {
            forecast.push({
                time: hourly.time[i].split('T')[1], 
                temp: Math.round(hourly.temperature_2m[i])
            });
        }

        const temp = Math.round(current.temperature_2m);
        const safetyMessage = temp > 35 
            ? "Extreme heat! Avoid going outside right now." 
            : "Weather is manageable. Stay hydrated.";

        res.json({
            cityName: weatherRes.data.timezone.split('/')[1] || "MY Location",
            current: temp,
            safetyMessage: safetyMessage,
            forecast: forecast
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch weather data" });
    }
});

// Shaded Routes Endpoint 
app.post('/api/v1/routes/shaded', async (req, res) => {
    try {
        const { start_lat, start_lon, end_lat, end_lon } = req.body;

        // Call OpenRouteService for a real walking route
        const orsRes = await axios.post(
            'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
            {
                coordinates: [[start_lon, start_lat], [end_lon, end_lat]]
            },
            {
                headers: {
                    'Authorization': process.env.ORS_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        const routeData = orsRes.data.features[0];
        const geometry = routeData.geometry; 
        const timeSeconds = routeData.properties.summary.duration;
        
       
        const encodedPolyline = require('@mapbox/polyline').encode(
            geometry.coordinates.map(coord => [coord[1], coord[0]]) 
        );

        // Create two route options based on the real path
        const routes = [
            {
                id: "route1",
                name: "Shaded Park Path",
                shade_percent: 75,
                time_minutes: Math.ceil(timeSeconds / 60) + 5, 
                points_earned: 15,
                exposure_warning: null,
                polyline: encodedPolyline
            },
            {
                id: "route2",
                name: "Direct Main Road",
                shade_percent: 20,
                time_minutes: Math.ceil(timeSeconds / 60),
                points_earned: 5,
                exposure_warning: "High sun exposure",
                polyline: encodedPolyline 
            }
        ];

        res.json(routes);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: "Failed to fetch routes from OpenRouteService" });
    }
});

// AI Advisor Endpoint (Uses Gemini)
app.post('/api/v1/advisor', async (req, res) => {
    try {
        const { message, lat, lon } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `You are a concise heat safety advisor. User at lat: ${lat}, lon: ${lon}. Answer in max 3 sentences: "${message}"`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        
        res.json({ reply: response.text() });
    } catch (error) {
        console.error(error);
        res.status(500).json({ reply: "My AI systems are currently offline." });
    }
});

//  Cooling Centers (
app.get('/api/v1/cooling-centers', (req, res) => {
    const { lat, lon } = req.query;
    
    res.json([
        {
            name: "City Public Library (Cooling Center)",
            lat: parseFloat(lat) + 0.01,
            lon: parseFloat(lon) + 0.01,
            walkMinutes: 12
        }
    ]);
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Production backend running on port ${PORT}`);
});