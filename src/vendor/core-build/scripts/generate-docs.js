/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import prettier from 'prettier';
import { cliOptions } from '../src/cli.js';
import { ToolCategory, labels } from '../src/tools/categories.js';
const MCP_SERVER_PATH = 'build/src/index.js';
const OUTPUT_PATH = './docs/tool-reference.md';
const README_PATH = './README.md';
const README_EN_PATH = './README_en.md';
const CHECK_MODE = process.argv.includes('--check');
function escapeHtmlTags(text) {
    return text
        .replace(/&(?![a-zA-Z]+;)/g, '&amp;')
        .replace(/<([a-zA-Z][^>]*)>/g, '&lt;$1&gt;');
}
function addCrossLinks(text, tools) {
    let result = text;
    // Create a set of all tool names for efficient lookup
    const toolNames = new Set(tools.map(tool => tool.name));
    // Sort tool names by length (descending) to match longer names first
    const sortedToolNames = Array.from(toolNames).sort((a, b) => b.length - a.length);
    for (const toolName of sortedToolNames) {
        // Create regex to match tool name (case insensitive, word boundaries)
        const regex = new RegExp(`\\b${toolName}\\b`, 'gi');
        result = result.replace(regex, match => {
            // Only create link if the match isn't already inside a link
            if (result.indexOf(`[${match}]`) !== -1) {
                return match; // Already linked
            }
            const anchorLink = toolName.toLowerCase();
            return `[\`${match}\`](#${anchorLink})`;
        });
    }
    return result;
}
function getCategoryName(category) {
    return labels[category] ?? category;
}
function generateConfigOptionsMarkdown() {
    let markdown = '';
    for (const [optionName, optionConfig] of Object.entries(cliOptions)) {
        // Skip hidden options
        if (optionConfig.hidden) {
            continue;
        }
        const aliasText = optionConfig.alias ? `, \`-${optionConfig.alias}\`` : '';
        const description = optionConfig.description || optionConfig.describe || '';
        // Start with option name and description
        markdown += `- **\`--${optionName}\`${aliasText}**\n`;
        markdown += `  ${description}\n`;
        // Add type information
        markdown += `  - **Type:** ${optionConfig.type}${optionConfig.array ? '[]' : ''}\n`;
        // Add choices if available
        if (optionConfig.choices) {
            markdown += `  - **Choices:** ${optionConfig.choices.map(c => `\`${c}\``).join(', ')}\n`;
        }
        // Add default if available
        if (optionConfig.default !== undefined) {
            markdown += `  - **Default:** \`${optionConfig.default}\`\n`;
        }
        markdown += '\n';
    }
    return markdown.trim();
}
function writeOrCheck(filePath, content) {
    if (CHECK_MODE) {
        const current = fs.readFileSync(filePath, 'utf8');
        if (current !== content) {
            throw new Error(`${filePath} is stale. Run npm run docs to regenerate documentation.`);
        }
        console.log(`Verified ${filePath}`);
        return;
    }
    fs.writeFileSync(filePath, content);
    console.log(`Updated ${filePath}`);
}
function updateReadmeToolCount(filePath, toolCount) {
    const current = fs.readFileSync(filePath, 'utf8');
    const pattern = filePath === README_PATH ? /## 工具列表（\d+ 个）/ : /## Tools \(\d+\)/;
    const replacement = filePath === README_PATH
        ? `## 工具列表（${toolCount} 个）`
        : `## Tools (${toolCount})`;
    const updated = current.replace(pattern, replacement);
    if (updated === current && !current.includes(replacement)) {
        throw new Error(`Could not find the tool count heading in ${filePath}`);
    }
    writeOrCheck(filePath, updated);
}
async function generateToolDocumentation() {
    console.log('Starting MCP server to query tool definitions...');
    // Create MCP client with stdio transport pointing to the built server
    const transport = new StdioClientTransport({
        command: 'node',
        args: [MCP_SERVER_PATH],
    });
    const client = new Client({
        name: 'docs-generator',
        version: '1.0.0',
    }, {
        capabilities: {},
    });
    try {
        // Connect to the server
        await client.connect(transport);
        console.log('Connected to MCP server');
        // List all available tools
        const { tools } = await client.listTools();
        const toolsWithAnnotations = tools;
        console.log(`Found ${tools.length} tools`);
        // Generate markdown documentation
        let markdown = `<!-- AUTO GENERATED DO NOT EDIT - run 'npm run docs' to update-->

# Chrome DevTools MCP Tool Reference

**Total: ${tools.length} tools.**

Every tool declares an MCP output schema. Successful calls and errors raised by
tool handlers or runtime operations return \`structuredContent\` with a stable
envelope: \`ok\`, \`tool\`, \`summary\`, optional machine-readable \`data\`, and an
\`error\` object (\`code\`, \`message\`, \`retryable\`) on failure. Protocol-level
input validation errors use the standard MCP/JSON-RPC error response. Text
content is kept for human-readable compatibility.

`;
        // Group tools by category (based on annotations)
        const categories = {};
        toolsWithAnnotations.forEach((tool) => {
            const category = tool._meta?.['io.github.zhizhuodemao/category'] || 'Uncategorized';
            if (!categories[category]) {
                categories[category] = [];
            }
            categories[category].push(tool);
        });
        // Sort categories using the enum order
        const categoryOrder = Object.values(ToolCategory);
        const sortedCategories = Object.keys(categories).sort((a, b) => {
            const aIndex = categoryOrder.indexOf(a);
            const bIndex = categoryOrder.indexOf(b);
            // Put known categories first, unknown categories last
            if (aIndex === -1 && bIndex === -1)
                return a.localeCompare(b);
            if (aIndex === -1)
                return 1;
            if (bIndex === -1)
                return -1;
            return aIndex - bIndex;
        });
        // Generate table of contents
        for (const category of sortedCategories) {
            const categoryTools = categories[category];
            const categoryName = getCategoryName(category);
            const anchorName = categoryName.toLowerCase().replace(/\s+/g, '-');
            markdown += `- **[${categoryName}](#${anchorName})** (${categoryTools.length} ${categoryTools.length === 1 ? 'tool' : 'tools'})\n`;
            // Sort tools within category for TOC
            categoryTools.sort((a, b) => a.name.localeCompare(b.name));
            for (const tool of categoryTools) {
                // Generate proper markdown anchor link: backticks are removed, keep underscores, lowercase
                const anchorLink = tool.name.toLowerCase();
                markdown += `  - [\`${tool.name}\`](#${anchorLink})\n`;
            }
        }
        markdown += '\n';
        for (const category of sortedCategories) {
            const categoryTools = categories[category];
            const categoryName = getCategoryName(category);
            markdown += `## ${categoryName}\n\n`;
            // Sort tools within category
            categoryTools.sort((a, b) => a.name.localeCompare(b.name));
            for (const tool of categoryTools) {
                markdown += `### \`${tool.name}\`\n\n`;
                if (tool.description) {
                    // Escape HTML tags but preserve JS function syntax
                    let escapedDescription = escapeHtmlTags(tool.description);
                    // Add cross-links to mentioned tools
                    escapedDescription = addCrossLinks(escapedDescription, toolsWithAnnotations);
                    markdown += `**Description:** ${escapedDescription}\n\n`;
                }
                // Handle input schema
                if (tool.inputSchema &&
                    tool.inputSchema.properties &&
                    Object.keys(tool.inputSchema.properties).length > 0) {
                    const properties = tool.inputSchema.properties;
                    const required = tool.inputSchema.required || [];
                    markdown += '**Parameters:**\n\n';
                    const propertyNames = Object.keys(properties).sort();
                    for (const propName of propertyNames) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const prop = properties[propName];
                        const isRequired = required.includes(propName);
                        const requiredText = isRequired
                            ? ' **(required)**'
                            : ' _(optional)_';
                        let typeInfo = prop.type || 'unknown';
                        if (prop.enum) {
                            typeInfo = `enum: ${prop.enum.map((v) => `"${v}"`).join(', ')}`;
                        }
                        markdown += `- **${propName}** (${typeInfo})${requiredText}`;
                        if (prop.description) {
                            let escapedParamDesc = escapeHtmlTags(prop.description);
                            // Add cross-links to mentioned tools
                            escapedParamDesc = addCrossLinks(escapedParamDesc, toolsWithAnnotations);
                            markdown += `: ${escapedParamDesc}`;
                        }
                        markdown += '\n';
                    }
                    markdown += '\n';
                }
                else {
                    markdown += '**Parameters:** None\n\n';
                }
                markdown += '---\n\n';
            }
        }
        markdown += `## CLI Configuration\n\n${generateConfigOptionsMarkdown()}\n`;
        const formattedMarkdown = await prettier.format(markdown.trim() + '\n', {
            parser: 'markdown',
        });
        writeOrCheck(OUTPUT_PATH, formattedMarkdown);
        console.log(`Generated documentation for ${toolsWithAnnotations.length} tools in ${OUTPUT_PATH}`);
        updateReadmeToolCount(README_PATH, toolsWithAnnotations.length);
        updateReadmeToolCount(README_EN_PATH, toolsWithAnnotations.length);
        await client.close();
    }
    catch (error) {
        console.error('Error generating documentation:', error);
        await client.close().catch(() => undefined);
        throw error;
    }
}
// Run the documentation generator
generateToolDocumentation().catch(() => {
    process.exitCode = 1;
});
