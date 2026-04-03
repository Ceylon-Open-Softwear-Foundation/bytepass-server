import express from "express";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const mongodbURI = process.env.MONGO_URI
const app = express();
const port = process.env.PORT;

mongoose.connect(mongodbURI).then(() => {
    console.log("Database connected successfully!");
});

app.listen(port, () => {
    console.log(`Server is Running on the port: ${port}`);
});