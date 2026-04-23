const fs = require('fs');
const path = require('path');

// Mock ToolExecutor and ToolResult for standalone test
class MockFileOps {
    constructor() {
        this.name = 'file_ops';
    }

    async execute(args) {
        // Copy-pasted logic from file_ops.ts for verification
        const action = args.action;
        let filePath = args.path;
        
        try {
            switch (action) {
                case 'create': {
                    const content = args.content || '';
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(filePath, content);
                    return { success: true, output: `Arquivo criado: ${filePath}` };
                }
                case 'read': {
                    if (!fs.existsSync(filePath)) return { success: false, error: 'Not found' };
                    const content = fs.readFileSync(filePath, 'utf-8');
                    return { success: true, output: content }; // Truncation removed!
                }
                case 'replace': {
                    const target = args.target;
                    const replacement = args.replacement;
                    const currentContent = fs.readFileSync(filePath, 'utf-8');
                    const newContent = currentContent.split(target).join(replacement);
                    fs.writeFileSync(filePath, newContent);
                    return { success: true, output: `Substituição realizada em: ${filePath}` };
                }
                case 'delete': {
                    fs.unlinkSync(filePath);
                    return { success: true };
                }
            }
        } catch (e) { return { success: false, error: e.message }; }
    }
}

async function runTest() {
    const tool = new MockFileOps();
    const testFile = path.join(__dirname, 'large_test.txt');

    console.log('--- TEST 1: Large File Reading ---');
    // Create a 10KB file (exceeds previous 4KB limit)
    const largeContent = 'A'.repeat(10000);
    await tool.execute({ action: 'create', path: testFile, content: largeContent });
    
    const readResult = await tool.execute({ action: 'read', path: testFile });
    console.log(`Read length: ${readResult.output.length}`);
    if (readResult.output.length === 10000) {
        console.log('✅ SUCCESS: Full content read (no truncation).');
    } else {
        console.log('❌ FAILURE: Content truncated.');
    }

    console.log('\n--- TEST 2: Replacement ---');
    const contentToReplace = 'HELLO WORLD';
    await tool.execute({ action: 'create', path: testFile, content: 'Prefix ' + contentToReplace + ' Suffix' });
    
    await tool.execute({ 
        action: 'replace', 
        path: testFile, 
        target: 'HELLO WORLD', 
        replacement: 'OPEN CLAW' 
    });
    
    const finalRead = await tool.execute({ action: 'read', path: testFile });
    console.log(`Final Content: ${finalRead.output}`);
    if (finalRead.output === 'Prefix OPEN CLAW Suffix') {
        console.log('✅ SUCCESS: Replacement worked correctly.');
    } else {
        console.log('❌ FAILURE: Replacement failed.');
    }

    // Cleanup
    await tool.execute({ action: 'delete', path: testFile });
}

runTest();
