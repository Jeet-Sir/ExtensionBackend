
import 'dotenv/config';
import { agentRouterFlow } from './src/flows/agentRouter.js';
import { agentExtractorFlow } from './src/flows/agentExtractor.js';
import { agentResolverFlow } from './src/flows/agentResolver.js';
import { agenticChat } from './src/flows/agenticChat.js';

async function testAgents() {
    console.log("🚀 Testing Agents...");

    // Mock Data
    const userProfile = {
        name: "John Doe",
        email: "john@example.com",
        phone: "1234567890"
    };

    const userDocuments = [
        {
            documentType: "aadhaar",
            extractedData: {
                "Full Name": "John Doe",
                "DOB": "01/01/1990",
                "Gender": "Male",
                "Address": "123 Main St, Bangalore"
            }
        },
        {
            documentType: "resume",
            extractedData: {
                "Skills": ["JavaScript", "Python"],
                "Experience": "5 years",
                "Phone": "1234567890"
            }
        }
    ];

    const fieldsMinimal = [
        { label: "Full Name", selector_id: null, selector_name: null, input_type: "text" },
        { label: "Date of Birth", selector_id: null, selector_name: "dob", input_type: "date" },
        { label: "Gender", options: ["Man", "Woman", "Other"], selector_id: "gender", selector_name: null },
        { label: "Skills", selector_id: null, selector_name: null }
    ];

    /*
  // 1. Test Router
  console.log("\n--- Testing Router ---");
  const routerResult = await agentRouterFlow({
    questions: ["Full Name", "Date of Birth", "Skills"],
    availableDocTypes: ["aadhaar", "resume", "profile"]
  });
  console.log("Router Output:", JSON.stringify(routerResult, null, 2));

  // 2. Test Extractor
  console.log("\n--- Testing Extractor (Aadhaar) ---");
  const extractorResult = await agentExtractorFlow({
    documentType: "aadhaar",
    extractedData: userDocuments[0].extractedData,
    questions: ["Full Name", "DOB"]
  });
  console.log("Extractor Output:", JSON.stringify(extractorResult, null, 2));

  // 3. Test Resolver
  console.log("\n--- Testing Resolver ---");
  const resolverResult = await agentResolverFlow({
    fieldLabel: "Gender",
    extractedValue: "Male",
    options: ["Man", "Woman", "Other"]
  });
  console.log("Resolver Output:", JSON.stringify(resolverResult, null, 2));
  */

    // 4. Test Orchestrator (Autofill)
    console.log("\n--- Testing Orchestrator (Autofill) ---");
    const orchestratorResult = await agenticChat({
        message: "Fill this form",
        userId: "test-user",
        fieldsMinimal,
        userDocuments,
        userProfile
    });
    console.log("Orchestrator Output (Autofill):", JSON.stringify(orchestratorResult, null, 2));

    // 5. Test Orchestrator (Question)
    console.log("\n--- Testing Orchestrator (Question) ---");
    const questionResult = await agenticChat({
        message: "What is my address?",
        userId: "test-user",
        userDocuments,
        userProfile
    });
    console.log("Orchestrator Output (Question):", JSON.stringify(questionResult, null, 2));
    // 6. Test Orchestrator (Meta-Question)
    console.log("\n--- Testing Orchestrator (Meta-Question) ---");
    const metaResult = await agenticChat({
        message: "How many documents do I have? What are they?",
        userId: "test-user",
        userDocuments,
        userProfile
    });
    console.log("Orchestrator Output (Meta-Question):", JSON.stringify(metaResult, null, 2));
}

testAgents();
