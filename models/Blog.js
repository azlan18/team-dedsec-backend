// models/Blog.js
const mongoose = require('mongoose');

// Blog schema
const blogSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('Blog', blogSchema);
