// test_colby_parsing.js
// Simple test to verify colby command parsing

// Import the parsing functions (in a real test, you'd import from the actual modules)
function parseTriggers(text) {
  const out = []

  // Original commands
  const originalRe = /^\s*\/(apply|fix|summarize|lint|test)\b.*$/gmi
  let m
  while ((m = originalRe.exec(text)) !== null) out.push(m[0].trim())

  // Colby commands
  const colbyRe = /^\s*\/colby\s+(implement|create\s+issue(?:\s+and\s+assign\s+to\s+copilot)?|bookmark\s+this\s+suggestion|extract\s+suggestions|help)\b.*$/gmi
  while ((m = colbyRe.exec(text)) !== null) out.push(m[0].trim())

  return out
}

function parseColbyCommand(trigger) {
  const cleanTrigger = trigger.replace(/^\/colby\s+/, '').trim()

  if (cleanTrigger === 'implement') {
    return { command: 'implement', args: {} }
  }

  if (cleanTrigger === 'create issue') {
    return { command: 'create_issue', args: { assignToCopilot: false } }
  }

  if (cleanTrigger.startsWith('create issue and assign to copilot')) {
    return { command: 'create_issue', args: { assignToCopilot: true } }
  }

  if (cleanTrigger === 'bookmark this suggestion') {
    return { command: 'bookmark_suggestion', args: {} }
  }

  if (cleanTrigger === 'extract suggestions') {
    return { command: 'extract_suggestions', args: {} }
  }

  if (cleanTrigger === 'help') {
    return { command: 'help', args: {} }
  }

  return { command: 'unknown', args: {} }
}

// Test cases
const testCases = [
  {
    name: "Basic colby implement",
    input: "/colby implement",
    expected: ["implement"]
  },
  {
    name: "Create issue command",
    input: "/colby create issue",
    expected: ["create_issue"]
  },
  {
    name: "Create issue with assignment",
    input: "/colby create issue and assign to copilot",
    expected: ["create_issue", true] // assignToCopilot should be true
  },
  {
    name: "Bookmark suggestion",
    input: "/colby bookmark this suggestion",
    expected: ["bookmark_suggestion"]
  },
  {
    name: "Extract suggestions",
    input: "/colby extract suggestions",
    expected: ["extract_suggestions"]
  },
  {
    name: "Help command",
    input: "/colby help",
    expected: ["help"]
  },
  {
    name: "Legacy apply command",
    input: "/apply",
    expected: ["/apply"]
  },
  {
    name: "Multiple commands",
    input: `/colby implement

/colby create issue

Also some regular text and then:

/apply

/colby help`,
    expected: 4 // Should find 4 commands total
  },
  {
    name: "Comment with suggestion blocks",
    input: `This code needs improvement:

\`\`\`suggestion
function better() {
  return "improved";
}
\`\`\`

/colby implement`,
    expected: ["implement"]
  }
]

console.log("🧪 Testing Colby Command Parsing")
console.log("================================")

let passed = 0
let failed = 0

testCases.forEach((test, index) => {
  console.log(`\n${index + 1}. ${test.name}`)

  try {
    const triggers = parseTriggers(test.input)
    console.log(`   Input: ${JSON.stringify(test.input.replace(/\n/g, '\\n'))}`)
    console.log(`   Found triggers: ${JSON.stringify(triggers)}`)

    if (Array.isArray(test.expected) && test.expected.length === 1) {
      // Test specific command parsing
      const colbyTriggers = triggers.filter(t => t.startsWith('/colby'))
      if (colbyTriggers.length > 0) {
        const parsed = parseColbyCommand(colbyTriggers[0])
        console.log(`   Parsed command: ${JSON.stringify(parsed)}`)

        if (parsed.command === test.expected[0]) {
          console.log("   ✅ PASS")
          passed++
        } else {
          console.log(`   ❌ FAIL - Expected command '${test.expected[0]}', got '${parsed.command}'`)
          failed++
        }
      } else {
        // Check for legacy commands
        if (triggers.includes(test.input.trim())) {
          console.log("   ✅ PASS (legacy command)")
          passed++
        } else {
          console.log("   ❌ FAIL - No triggers found")
          failed++
        }
      }
    } else if (typeof test.expected === "number") {
      // Test total count
      if (triggers.length === test.expected) {
        console.log("   ✅ PASS")
        passed++
      } else {
        console.log(`   ❌ FAIL - Expected ${test.expected} triggers, got ${triggers.length}`)
        failed++
      }
    } else if (test.expected.length === 2) {
      // Test with additional args check
      const colbyTriggers = triggers.filter(t => t.startsWith('/colby'))
      if (colbyTriggers.length > 0) {
        const parsed = parseColbyCommand(colbyTriggers[0])
        console.log(`   Parsed command: ${JSON.stringify(parsed)}`)

        if (parsed.command === test.expected[0] && parsed.args.assignToCopilot === test.expected[1]) {
          console.log("   ✅ PASS")
          passed++
        } else {
          console.log(`   ❌ FAIL - Expected command '${test.expected[0]}' with assignToCopilot=${test.expected[1]}`)
          failed++
        }
      } else {
        console.log("   ❌ FAIL - No colby triggers found")
        failed++
      }
    }

  } catch (error) {
    console.log(`   ❌ ERROR - ${error.message}`)
    failed++
  }
})

console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed`)

if (failed === 0) {
  console.log("🎉 All tests passed! Colby command parsing is working correctly.")
} else {
  console.log("⚠️  Some tests failed. Check the implementation.")
}

// Example usage output
console.log("\n📝 Example Usage:")
console.log("=================")

const exampleComment = `Great PR! I have a few suggestions:

\`\`\`suggestion
// Add error handling
if (!data) {
  throw new Error('Data is required');
}
\`\`\`

/colby implement

Also, please create an issue for the documentation updates:

/colby create issue and assign to copilot`

const exampleTriggers = parseTriggers(exampleComment)
console.log("Comment triggers found:", exampleTriggers)

exampleTriggers.filter(t => t.startsWith('/colby')).forEach(trigger => {
  const parsed = parseColbyCommand(trigger)
  console.log(`Command: ${trigger} → ${JSON.stringify(parsed)}`)
})
