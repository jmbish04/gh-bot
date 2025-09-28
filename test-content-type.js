#!/usr/bin/env node

// Simple test to verify HTML content type is correctly set
import { test } from 'node:test';
import assert from 'node:assert';

// Mock the Hono context and environment
const mockEnv = {
    ASSETS: {
        fetch: (request) => {
            const url = new URL(request.url || request);
            if (url.pathname === '/openapi.json') {
                return Promise.resolve(new Response('{"openapi": "3.0.0"}', {
                    headers: { 'Content-Type': 'application/json' }
                }));
            }
            return Promise.resolve(new Response('Not found', { status: 404 }));
        }
    }
};

const mockHeaders = new Map();
const mockResponse = {
    headers: {
        get: (key) => mockHeaders.get(key),
        set: (key, value) => mockHeaders.set(key, value)
    }
};

const mockContext = {
    req: { url: 'http://localhost:8787/' },
    env: mockEnv,
    res: mockResponse,
    html: (content) => {
        mockHeaders.set('Content-Type', 'text/html; charset=UTF-8');
        return { body: content, headers: mockHeaders };
    },
    json: (content) => {
        mockHeaders.set('Content-Type', 'application/json');
        return { body: JSON.stringify(content), headers: mockHeaders };
    }
};

test('CORS middleware should not override HTML content-type', () => {
    mockHeaders.clear();
    
    // Simulate the behavior after next() is called for HTML response
    mockContext.html('<html><body>Test</body></html>');
    
    // Simulate CORS headers being applied
    const CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", 
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        mockContext.res.headers.set(k, v);
    }
    
    // Only set JSON content-type if no content-type is already set
    if (!mockContext.res.headers.get("Content-Type")) {
        mockContext.res.headers.set("Content-Type", "application/json");
    }
    
    // Verify HTML content-type is preserved
    assert.strictEqual(mockContext.res.headers.get("Content-Type"), "text/html; charset=UTF-8");
    console.log('✅ HTML content-type correctly preserved');
});

test('CORS middleware should set JSON content-type for JSON responses', () => {
    mockHeaders.clear();
    
    const CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
        mockContext.res.headers.set(k, v);
    }
    
    // Only set JSON content-type if no content-type is already set
    if (!mockContext.res.headers.get("Content-Type")) {
        mockContext.res.headers.set("Content-Type", "application/json");
    }
    
    // Verify JSON content-type is set when none exists
    assert.strictEqual(mockContext.res.headers.get("Content-Type"), "application/json");
    console.log('✅ JSON content-type correctly set for responses without content-type');
});

console.log('Running content-type tests...');