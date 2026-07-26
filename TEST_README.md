# XCut API Function Test Suite

This test suite allows you to run and test all functions from the XCut API independently using the JSON data files in the `/data` directory.

## Overview

The test suite covers all major functions from `/app/api/[[...path]]/route.js`:

- **Utility Functions**: Timestamp generation, formatting, VAD processing
- **Data Loading**: JSON file loading and validation
- **Data Integrity**: Structure validation and duplicate detection
- **Function Imports**: Testing function availability and extraction
- **Runtime Errors**: Detection of const reassignment and other runtime bugs
- **Transcription**: Audio transcription (mocked)
- **Pipeline Stages**: All 6 stages of the agent reasoning pipeline

## Prerequisites

1. Node.js installed
2. Dependencies installed: `npm install`
3. JSON data files in `/data` directory

## Quick Start

### Run All Tests
```bash
npm test
# or
node test_functions.js
```

### Run Specific Test Categories
```bash
# Utility functions
npm run test:utils

# Data loading and integrity
npm run test:data
npm run test:integrity

# Function availability and runtime errors
npm run test:imports
npm run test:runtime

# Transcription functions
npm run test:transcription

# Individual pipeline stages
npm run test:stage1      # Idea extraction
npm run test:stage1.5    # Delivery quality analysis
npm run test:stage1.75   # Thought merging
npm run test:stage2      # Publish-worthiness ranking
npm run test:stage3      # Internet framing
npm run test:stage4      # Script generation

# Isolated runtime error testing
npm run test:runtime-isolated  # Direct const reassignment bug detection
```

## Test Data

The tests use real JSON data from processed videos:

- `video_1765663736164_05iwljjbc_transcript.json` - Transcription data
- `video_1765663736164_05iwljjbc_vad_timestamps.json` - Voice activity detection
- `video_1765663736164_05iwljjbc_idea_units.json` - Extracted idea units
- `video_1765663736164_05iwljjbc_stage1_5_delivery.json` - Delivery analysis
- `video_1765663736164_05iwljjbc_stage1_75_merged.json` - Merged thought units

## Test Structure

### Utility Functions Tests
- `generateTimestampId()` - ID generation
- `formatTimestamp()` - Time formatting
- `applyVADTolerances()` - VAD segment processing

### Data Loading Tests
- JSON file loading and validation
- Data structure integrity checks

### Transcription Tests
- Mock transcription functionality
- Audio processing simulation

### Pipeline Stage Tests

#### Stage 1: Idea Extraction
- Tests LLM prompting for idea unit extraction
- Validates output format and required fields

#### Stage 1.5: Delivery Quality Analysis
- Tests delivery quality evaluation
- Validates scoring and flagging logic

#### Stage 1.75: Thought Continuity & Merge Engine
- Tests thought merging algorithms
- Validates canonical ID assignment

#### Stage 2: Publish-Worthiness Ranking
- Tests editorial ranking logic
- Validates content role assignment

#### Stage 3: Internet Framing
- Tests story type and energy assignment
- Validates format tag selection

#### Stage 4: Script Skeleton Generation
- Tests script structure creation
- Validates hook, body outline, and CTA generation

## Runtime Error Detection

The test suite includes specialized tests to catch runtime errors:

### Runtime Error Tests
- **Const Reassignment Errors**: Detects attempts to reassign `const` variables
- **Variable Declaration Issues**: Catches missing or incorrect variable declarations
- **Function Execution Errors**: Tests actual function execution with real data

### Data Integrity Tests
- **JSON Structure Validation**: Ensures required fields exist
- **Duplicate Detection**: Finds duplicate IDs that could cause issues
- **Data Consistency**: Validates relationships between data structures
- **Missing Fields**: Identifies missing required properties

### Example Runtime Error Detection

```bash
🔥 Testing Runtime Errors: Const Reassignment Bug
==================================================
Calling analyzeDeliveryQuality with test data...
[STAGE 1.5] Analyzing delivery quality for 2 idea units...
[STAGE 1.5] ✓ Idea 1: delivery_score=0.8, flags=0
[STAGE 1.5] ✓ Idea 2: delivery_score=0.8, flags=0
✅ SUCCESS: Caught the const reassignment error!
   Error: Assignment to constant variable.
   This confirms the bug exists in the original code
```

### Example Data Integrity Warning

```
🔍 Testing Data Integrity & Structure Validation...
Analyzing 5 delivery analysis entries...
⚠️  Duplicate idea_ids found in delivery analysis: 5 entries but 1 unique IDs
   IDs: 1, 1, 1, 1, 1
```

## Mock Functions

The test suite includes mock implementations for external dependencies:

- **OpenAI API**: Returns predetermined responses based on prompt content
- **Groq API**: Returns mock transcription data
- **File I/O**: Uses existing JSON files instead of creating new ones

## Test Output

Each test provides:
- ✅ **PASSED**: Test completed successfully
- ❌ **FAILED**: Test failed with error message
- 📊 **Summary**: Total passed/failed counts

Example output:
```
🚀 Starting XCut API Function Tests
==================================================
🔬 Running: Utility Functions
✓ generateTimestampId: video_1234567890_abc123def
✓ formatTimestamp: 01:01:01
✓ applyVADTolerances: [...]
✅ PASSED: Utility Functions

📁 Testing Data Loading...
✅ PASSED: Data Loading

🏁 Test Results Summary
==================================================
✅ Passed: 8
❌ Failed: 0
📊 Total: 8
```

## API Key Requirements

The test suite works with or without API keys:

- **With API keys**: Tests make real API calls (use carefully due to costs)
- **Without API keys**: Uses mock responses for all external APIs

Set environment variables if you want real API testing:
```bash
export OPENAI_API_KEY=your_key_here
export GROQ_API_KEY=your_key_here
```

## Adding New Tests

To add new test functions:

1. Create a test function following the pattern:
```javascript
const testNewFunction = async () => {
  console.log('\n🔬 Testing New Function...');
  // Your test logic here
  assert(condition, 'Error message');
  console.log('✅ New function tests passed');
};
```

2. Add it to the test runner in `runAllTests()`:
```javascript
await runTest('New Function', testNewFunction);
```

3. Add CLI support in the testMap:
```javascript
const testMap = {
  // ... existing tests
  'newfunction': testNewFunction
};
```

## Troubleshooting

### Common Issues

1. **Missing data files**: Ensure `/data` directory contains required JSON files
2. **Import errors**: Run `npm install` to install dependencies
3. **ES modules**: Ensure Node.js version supports ES modules

### Debug Mode

For detailed logging, add console.log statements to test functions or modify the mock functions to show more details.

## Integration with Main API

This test suite validates the core logic of the API without requiring:
- Video file uploads
- FFmpeg processing
- External API calls (when mocked)
- File system writes

Use it to validate algorithm changes and ensure pipeline stages work correctly before deploying.
